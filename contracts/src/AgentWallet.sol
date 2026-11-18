// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

interface IFactoryView {
    function operator() external view returns (address);
    function treasury() external view returns (address);
    function markupBps() external view returns (uint16);
    function usdg() external view returns (address);
}

/// @title AgentWallet
/// @notice Holds one agent's USDG. Customers pay it directly. The factory's
///         meter may charge it for runs, but only to the factory treasury and
///         only inside the limits its owner set. The owner can take the money
///         out at any time. The treasury address and the markup are fixed when
///         the wallet is made; later factory changes reach a wallet only if
///         its owner adopts them.
/// @dev    Deployed as a minimal clone by ZeroLuxFactory. Threat model: the
///         operator key and everything off chain are untrusted. A stolen
///         operator key can move at most `perDayCap` per day, and only to the
///         treasury, never to an address of its choosing. A stolen factory
///         owner key cannot change where this wallet pays or what markup it
///         pays. The day cap is a UTC calendar day, so the worst case across
///         midnight is two day caps.
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

    event Charged(bytes32 indexed runId, uint256 cost, uint256 fee, address indexed treasury);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event LimitsSet(uint128 perRunCap, uint128 perDayCap);
    event PausedSet(bool paused);
    event TermsAdopted(address indexed treasury, uint16 markupBps);
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
        treasury = IFactoryView(msg.sender).treasury();
        markupBps = IFactoryView(msg.sender).markupBps();
        emit OwnershipTransferred(address(0), owner_);
        emit LimitsSet(perRunCap_, perDayCap_);
        emit TermsAdopted(treasury, markupBps);
    }

    /// @notice Charge the agent for one run. `cost` is the model cost in USDG
    ///         units; this wallet's markup is added on top. Pays this wallet's treasury.
    function charge(bytes32 runId, uint256 cost) external {
        IFactoryView f = IFactoryView(factory);
        if (msg.sender != f.operator()) revert NotOperator();
        if (paused) revert Paused();
        if (cost == 0) revert ZeroCost();
        if (runCharged[runId]) revert RunAlreadyCharged();

        uint256 fee = (cost * markupBps) / 10_000;
        uint256 total = cost + fee;
        if (total > perRunCap) revert OverRunCap();
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOnDay[day] + total;
        if (spent > perDayCap) revert OverDayCap();

        runCharged[runId] = true;
        spentOnDay[day] = spent;
        totalCharged += total;

        address to = treasury;
        _send(f.usdg(), to, total);
        emit Charged(runId, cost, fee, to);
    }

    /// @notice What the meter could still charge today.
    function remainingToday() external view returns (uint256) {
        uint256 spent = spentOnDay[block.timestamp / 1 days];
        return spent >= perDayCap ? 0 : perDayCap - spent;
    }

    // ---- owner ----

    /// @notice Take any token out, any amount, any time. No delay.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
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
    function adoptTerms(address expectedTreasury, uint16 expectedMarkupBps) external onlyOwner {
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

    function _send(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
    }
}
