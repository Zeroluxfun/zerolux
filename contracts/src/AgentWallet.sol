// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

interface IFactoryView {
    function operator() external view returns (address);
    function treasury() external view returns (address);
    function markupBps() external view returns (uint16);
    function usdg() external view returns (address);
}

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

/// @title AgentWallet
/// @notice Holds one agent's USDG. Customers pay it directly. The factory's
///         meter may charge it for runs, but only to the factory treasury and
///         only inside the limits its owner set. The owner can take the money
///         out at any time. The treasury address and the markup are fixed when
///         the wallet is made; later factory changes reach a wallet only if
///         its owner adopts them.
///
///         Because every dollar the agent earns lands here and every run it
///         pays for leaves from here, its profit is a fact anyone can read:
///         `income()` less `totalCharged`. The owner can pledge a share of
///         that profit to someone else (a lender, a buyer, a buyback contract)
///         with `setLien`. While a lien stands, the pledged share is held back
///         from the owner's withdrawals and anyone may send it to the payee.
///
///         Money arrives before the run it paid for is billed, so raw profit
///         is briefly too high. The lien therefore pays only on *settled*
///         profit: a checkpoint the meter moves forward as it bills. Income
///         past the checkpoint is held for everyone until it is settled. If
///         the meter goes quiet, anyone can ask for a checkpoint and take it
///         a day later; a meter that is alive must bill or settle within
///         that day, because a taken checkpoint counts unbilled money as final.
/// @dev    Deployed as a minimal clone by ZeroLuxFactory. Threat model: the
///         operator key and everything off chain are untrusted. A stolen
///         operator key can move at most `perDayCap` per day, and only to the
///         treasury, never to an address of its choosing. A stolen factory
///         owner key cannot change where this wallet pays or what markup it
///         pays. The day cap is a UTC calendar day, so the worst case across
///         midnight is two day caps. A lien is only as good as the money
///         that reaches this wallet: the factory's hosted endpoint always
///         names this wallet as the address to pay, but nothing on chain
///         stops an owner from selling the same work somewhere else. A
///         hostile operator cannot take pledged money, but it can hold the
///         checkpoint back (freezing fresh income while a lien stands) and
///         its charges, which reach only the treasury, lower the profit a
///         lien is paid from. A lien on a wallet whose owner also controls
///         the factory is a promise by that one party.
contract AgentWallet {
    address public factory;
    address public owner;
    address public pendingOwner;

    uint128 public perRunCap; // most a single run may cost, fee included
    uint128 public perDayCap; // most all runs may cost in one UTC day, fee included
    bool public paused; // owner switch: no charges while true

    address public treasury; // where run charges go; fixed at creation, changed only by adoptTerms
    uint16 public markupBps; // markup on a run's cost; fixed at creation, changed only by adoptTerms

    mapping(uint256 day => uint256 spent) public spentOnDay;
    mapping(bytes32 runId => bool used) public runCharged;

    uint256 public totalCharged; // lifetime, fee included

    address public usdg;
    uint256 public totalOut; // USDG this wallet has ever sent out: charges, withdrawals, lien payments

    struct Lien {
        address payee; // who the pledged share is paid to
        uint16 bps; // share of profit pledged, in hundredths of a percent
        uint128 cap; // most the lien will ever pay; 0 = no cap
        uint128 paid; // paid to the payee so far
        uint256 baseProfit; // lifetime profit when the lien began
    }

    Lien public lien;

    bytes32 public lienTermsConsent; // the payee's yes to one specific change of treasury and markup
    mapping(address => uint256) public parked; // lien money USDG would not deliver; its payee can claim it
    uint256 public parkedTotal;

    uint256 public settledProfit; // the checkpoint: profit counted as final
    uint256 public pendingProfit; // a checkpoint someone asked for
    uint64 public pendingAt; // when they asked; 0 = none
    uint256 public constant CHECKPOINT_DELAY = 1 days;

    event Charged(bytes32 indexed runId, uint256 cost, uint256 fee, address indexed treasury);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event LimitsSet(uint128 perRunCap, uint128 perDayCap);
    event PausedSet(bool paused);
    event TermsAdopted(address indexed treasury, uint16 markupBps);
    event LienSet(address indexed payee, uint16 bps, uint128 cap);
    event LienPaid(address indexed payee, uint256 amount);
    event LienEnded(address indexed payee, uint256 paid);
    event LienPayeeSet(address indexed from, address indexed to);
    event Parked(address indexed payee, uint256 amount);
    event Settled(uint256 settledProfit);
    event CheckpointRequested(uint256 profit, uint256 readyAt);
    event OwnershipOffered(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotOperator();
    error AlreadyInitialised();
    error Paused();
    error RunAlreadyCharged();
    error OverRunCap();
    error OverDayCap();
    error ZeroAddress();
    error ZeroCost();
    error TransferFailed();
    error TermsChanged();
    error LienExists();
    error NoLien();
    error LienStands();
    error LienOwed();
    error BadLien();
    error CheckpointPending();
    error NoCheckpoint();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Locks the bare implementation so nobody can initialise it.
    constructor() {
        factory = address(1);
    }

    function init(address owner_, uint128 perRunCap_, uint128 perDayCap_) external {
        if (factory != address(0)) revert AlreadyInitialised();
        if (owner_ == address(0)) revert ZeroAddress();
        factory = msg.sender;
        owner = owner_;
        perRunCap = perRunCap_;
        perDayCap = perDayCap_;
        usdg = IFactoryView(msg.sender).usdg();
        treasury = IFactoryView(msg.sender).treasury();
        markupBps = IFactoryView(msg.sender).markupBps();
        emit OwnershipTransferred(address(0), owner_);
        emit LimitsSet(perRunCap_, perDayCap_);
        emit TermsAdopted(treasury, markupBps);
    }

    /// @notice Charge the agent for one run. `cost` is the model cost in USDG
    ///         units; this wallet's markup is added on top. Pays this wallet's treasury.
    function charge(bytes32 runId, uint256 cost) external {
        _onlyOperator();
        _charge(runId, cost);
    }

    /// @notice Charge a run and move the checkpoint. `settledUpTo` is the profit the
    ///         meter counts as final: profit after this charge, less money held for
    ///         runs it has not billed yet. It is a fixed figure, so a payment that
    ///         lands while this call is in flight is never counted by accident.
    function chargeAndSettle(bytes32 runId, uint256 cost, uint256 settledUpTo) external {
        _onlyOperator();
        _charge(runId, cost);
        _checkpoint(settledUpTo);
    }

    /// @notice Move the checkpoint without charging a run.
    function settle(uint256 settledUpTo) external {
        _onlyOperator();
        _checkpoint(settledUpTo);
    }

    function _onlyOperator() private view {
        if (msg.sender != IFactoryView(factory).operator()) revert NotOperator();
    }

    function _checkpoint(uint256 settledUpTo) private {
        uint256 p = profit();
        uint256 next = settledUpTo < p ? settledUpTo : p;
        // Money that was here before the lien began is the owner's and is never unsettled.
        if (lien.payee != address(0) && next < lien.baseProfit) next = p < lien.baseProfit ? p : lien.baseProfit;
        settledProfit = next;
        pendingAt = 0;
        emit Settled(settledProfit);
    }

    /// @notice If the meter has stopped settling, anyone may ask for a checkpoint at
    ///         today's profit and take it after a day. A day gives the meter time
    ///         to bill what that money paid for.
    function requestCheckpoint() external {
        if (pendingAt != 0) revert CheckpointPending();
        pendingProfit = profit();
        pendingAt = uint64(block.timestamp);
        emit CheckpointRequested(pendingProfit, block.timestamp + CHECKPOINT_DELAY);
    }

    function takeCheckpoint() external {
        if (pendingAt == 0 || block.timestamp < pendingAt + CHECKPOINT_DELAY) revert NoCheckpoint();
        uint256 p = profit();
        uint256 asked = pendingProfit;
        uint256 next = asked < p ? asked : p;
        if (next > settledProfit) settledProfit = next;
        pendingAt = 0;
        emit Settled(settledProfit);
    }

    function _charge(bytes32 runId, uint256 cost) private {
        if (paused) revert Paused();
        if (cost == 0) revert ZeroCost();
        if (runCharged[runId]) revert RunAlreadyCharged();

        uint256 fee = (cost * markupBps) / 10_000;
        uint256 total = cost + fee;
        if (total > perRunCap) revert OverRunCap();
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOnDay[day] + total;
        if (spent > perDayCap) revert OverDayCap();

        if (parkedTotal != 0 && _balance() < total + parkedTotal) revert TransferFailed();

        runCharged[runId] = true;
        spentOnDay[day] = spent;
        totalCharged += total;

        address to = treasury;
        _send(usdg, to, total);
        // A charge lowers profit; the checkpoint can never sit above it.
        uint256 p = profit();
        if (settledProfit > p) settledProfit = p;
        emit Charged(runId, cost, fee, to);
    }

    /// @notice What the meter could still charge today.
    function remainingToday() external view returns (uint256) {
        uint256 spent = spentOnDay[block.timestamp / 1 days];
        return spent >= perDayCap ? 0 : perDayCap - spent;
    }

    // ---- the record ----

    /// @notice Every USDG this wallet has ever received.
    function income() public view returns (uint256) {
        return _balance() + totalOut;
    }

    /// @notice Lifetime income less lifetime run charges.
    function profit() public view returns (uint256) {
        return income() - totalCharged;
    }

    /// @notice Profit not yet counted as final: money in since the last checkpoint.
    function unsettled() public view returns (uint256) {
        uint256 p = profit();
        return p > settledProfit ? p - settledProfit : 0;
    }

    /// @notice What the lien has earned on settled profit and not yet been paid,
    ///         whether or not the wallet holds it.
    function lienUnpaid() public view returns (uint256) {
        Lien memory l = lien;
        if (l.payee == address(0)) return 0;
        uint256 p = profit();
        if (p > settledProfit) p = settledProfit;
        uint256 gained = p > l.baseProfit ? p - l.baseProfit : 0;
        uint256 accrued = (gained * l.bps) / 10_000;
        if (l.cap != 0 && accrued > l.cap) accrued = l.cap;
        return accrued > l.paid ? accrued - l.paid : 0;
    }

    /// @notice What the owner can take out in USDG right now. With no lien, all of
    ///         it. Under a lien, the payee's unpaid share and any income not yet
    ///         settled stay behind.
    function withdrawable() public view returns (uint256) {
        uint256 bal = _balance();
        uint256 held = parkedTotal;
        if (lien.payee != address(0)) held += lienUnpaid() + unsettled();
        return held >= bal ? 0 : bal - held;
    }

    // ---- lien ----

    /// @notice Pledge `bps` of this wallet's profit from now on to `payee`, up to
    ///         `cap` in total (0 = no limit). One lien at a time, and it cannot be
    ///         changed. It ends when the payee releases it, or, by the owner, once
    ///         it has paid its cap. A lien with no cap lasts until its payee lets go.
    ///         The share is of running profit: money the payee has earned but not
    ///         collected shrinks if later runs lose money, so collect often.
    function setLien(address payee, uint16 bps, uint128 cap) external onlyOwner {
        if (lien.payee != address(0)) revert LienExists();
        if (payee == address(0) || payee == address(this)) revert ZeroAddress();
        if (bps == 0 || bps > 10_000) revert BadLien();
        uint256 p = profit();
        lien = Lien(payee, bps, cap, 0, p);
        settledProfit = p; // money already here is the owner's; the lien starts from now
        pendingAt = 0;
        lienTermsConsent = bytes32(0);
        emit LienSet(payee, bps, cap);
    }

    /// @notice Pay the payee what the lien has earned. Anyone may call.
    function settleLien() external returns (uint256 amount) {
        if (lien.payee == address(0)) revert NoLien();
        amount = _settle();
    }

    /// @notice End the lien. The payee may release it at any time (call settleLien
    ///         first to collect). The owner may end it once it has paid its cap; the
    ///         last of what it is owed is paid in the same call, and if USDG will
    ///         not deliver to the payee the money is set aside for them to claim.
    function endLien() external {
        Lien memory l = lien;
        if (l.payee == address(0)) revert NoLien();
        if (msg.sender != l.payee) {
            if (msg.sender != owner) revert NotOwner();
            uint256 owed = lienUnpaid();
            uint256 bal = _balance();
            if (bal < parkedTotal || owed > bal - parkedTotal) revert LienStands(); // not all there yet
            if (l.cap == 0 || l.paid + owed < l.cap) revert LienStands();
            if (owed != 0) {
                lien.paid = l.paid + uint128(owed); // owed never takes paid past cap
                if (_trySend(usdg, l.payee, owed)) {
                    emit LienPaid(l.payee, owed);
                } else {
                    parked[l.payee] += owed;
                    parkedTotal += owed;
                    emit Parked(l.payee, owed);
                }
            }
        }
        uint256 paid = lien.paid;
        delete lien;
        lienTermsConsent = bytes32(0);
        emit LienEnded(l.payee, paid);
    }

    /// @notice Collect lien money that was set aside, to any address.
    function claimParked(address to) external {
        uint256 amount = parked[msg.sender];
        if (amount == 0) revert NoLien();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        parked[msg.sender] = 0;
        parkedTotal -= amount;
        _send(usdg, to, amount);
        emit LienPaid(to, amount);
    }

    /// @notice The payee agrees to the owner adopting one specific treasury and markup.
    function consentToTerms(address treasury_, uint16 markupBps_) external {
        if (msg.sender != lien.payee || msg.sender == address(0)) revert NotOwner();
        lienTermsConsent = keccak256(abi.encode(treasury_, markupBps_));
    }

    /// @notice The payee may point the lien at another address, for example if
    ///         USDG will no longer pay the first one.
    function setLienPayee(address to) external {
        address from = lien.payee;
        if (from == address(0)) revert NoLien();
        if (msg.sender != from) revert NotOwner();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        lien.payee = to;
        lienTermsConsent = bytes32(0); // the new payee has agreed to nothing
        emit LienPayeeSet(from, to);
    }

    function _settle() private returns (uint256 amount) {
        amount = lienUnpaid();
        uint256 bal = _balance();
        bal = bal > parkedTotal ? bal - parkedTotal : 0;
        if (amount > bal) amount = bal;
        if (amount == 0) return 0;
        address payee = lien.payee;
        if (amount > type(uint128).max - lien.paid) revert BadLien();
        lien.paid += uint128(amount);
        _send(usdg, payee, amount);
        emit LienPaid(payee, amount);
    }

    // ---- owner ----

    /// @notice Take any token out at any time, with no delay. The one limit applies
    ///         only while a lien stands: see `withdrawable`.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        if (token == usdg && amount > withdrawable()) revert LienOwed();
        _send(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    function setLimits(uint128 perRunCap_, uint128 perDayCap_) external onlyOwner {
        perRunCap = perRunCap_;
        perDayCap = perDayCap_;
        emit LimitsSet(perRunCap_, perDayCap_);
    }

    /// @notice Take on the factory's current treasury and markup. The owner names the
    ///         values they mean; if the factory holds anything else, nothing changes.
    ///         While a lien stands its payee must first agree to these exact terms.
    function adoptTerms(address expectedTreasury, uint16 expectedMarkupBps) external onlyOwner {
        if (lien.payee != address(0)) {
            if (lienTermsConsent != keccak256(abi.encode(expectedTreasury, expectedMarkupBps))) revert LienExists();
            lienTermsConsent = bytes32(0);
        }
        IFactoryView f = IFactoryView(factory);
        if (f.treasury() != expectedTreasury || f.markupBps() != expectedMarkupBps) revert TermsChanged();
        treasury = expectedTreasury;
        markupBps = expectedMarkupBps;
        emit TermsAdopted(expectedTreasury, expectedMarkupBps);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipOffered(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _balance() private view returns (uint256) {
        return IERC20Balance(usdg).balanceOf(address(this));
    }

    function _trySend(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) return false;
        if (token == usdg) totalOut += amount;
        return true;
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == usdg) totalOut += amount;
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
    }
}
