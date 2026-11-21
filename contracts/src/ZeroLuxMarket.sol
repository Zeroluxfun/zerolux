// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IMarketFactoryV3 {
    function usdg() external view returns (address);
    function treasury() external view returns (address);
    function isAgentWallet(address wallet) external view returns (bool);
}

interface IMarketWalletV3 {
    function owner() external view returns (address);
    function lien() external view returns (address payee, uint16 bps, uint128 cap, uint128 paid, uint256 baseProfit);
    function lienUnpaid() external view returns (uint256);
    function parked(address who) external view returns (uint256);
    function customOperator() external view returns (address);
    function paused() external view returns (bool);
    function settleLien() external returns (uint256);
    function endLien() external;
    function setLienPayee(address to) external;
    function claimParked(address to) external;
}

interface IMarketERC20 {
    function balanceOf(address) external view returns (uint256);
}

interface IMarketLocker {
    function MAX_LOCK() external view returns (uint64);
    function locked(address account) external view returns (uint256 amount, uint64 unlockAt);
    function lockedOf(address account) external view returns (uint256);
}

/// @title PledgeEscrow
/// @notice Stands in as the payee of one agent wallet's pledge while that pledge
///         is for sale. One per wallet, made by the market at an address anyone
///         can work out beforehand. It does only what the market tells it, and
///         the market can tell it only four things: hand the pledge to a buyer,
///         end the pledge, bring in money the wallet set aside for it, and send
///         on the USDG it holds.
/// @dev    Each wallet has its own so that money one wallet pays out before a
///         sale can never be mixed with another's. The wallet's `paid` counter
///         says how much a pledge has paid, not to whom, and a payee can point a
///         used pledge at any address, so a shared pot could be talked into
///         paying out money it never received. Here whatever sits in the escrow
///         came from this one wallet (or was sent as a gift) and goes to this
///         one wallet's seller.
contract PledgeEscrow {
    address public immutable market;

    error NotMarket();
    error TransferFailed();

    constructor() {
        market = msg.sender;
    }

    modifier onlyMarket() {
        if (msg.sender != market) revert NotMarket();
        _;
    }

    function handOver(address wallet, address to) external onlyMarket {
        IMarketWalletV3(wallet).setLienPayee(to);
    }

    function release(address wallet) external onlyMarket {
        IMarketWalletV3(wallet).endLien();
    }

    function claimParked(address wallet) external onlyMarket {
        IMarketWalletV3(wallet).claimParked(address(this));
    }

    /// @notice Send everything held to `to`. If the token will not deliver, fail
    ///         when `strict`, otherwise leave the money here and report nothing sent.
    function sweep(address token, address to, bool strict) external onlyMarket returns (uint256 amount) {
        amount = IMarketERC20(token).balanceOf(address(this));
        if (amount == 0) return 0;
        // transfer(address,uint256)
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            if (strict) revert TransferFailed();
            return 0;
        }
    }
}

/// @title ZeroLuxMarket
/// @notice Where the owner of an agent sells a pledged share of its future
///         profit, and a backer buys it in one transaction.
///
///         The owner's side, two calls:
///           1. wallet.setLien(market.escrowOf(wallet), bps, cap)
///           2. market.list(wallet, price, bps, cap)
///         The backer's side, two calls:
///           1. usdg.approve(market, price)
///           2. market.buy(wallet, price, bps, cap, maxPaid, maxBase)
///         On a sale the price goes straight from the buyer to the seller, less
///         the fee, which goes straight to the factory's treasury, and the
///         pledge's payee becomes the buyer. From then on the wallet pays the
///         buyer directly (`settleLien`, which anyone may call) and this
///         contract has no part in it.
///
///         What the pledge earned before the sale is the seller's: it is paid
///         out of the wallet at the moment of sale and sent to the seller.
///         A seller can take an unsold pledge back with `cancel`, which ends it
///         on the wallet, so the agent is never left pledged to nobody.
///
///         A listing is the seller's only while they still own the wallet. If
///         the wallet changes hands, the pledge that is for sale and whatever
///         it has paid into the escrow go with it, the same as the wallet's
///         balance does: from then on only the new owner can cancel or
///         collect, the old seller can do neither, and nobody can buy until
///         the new owner lists it as their own.
///
///         A wallet whose owner has named its own meter cannot be listed or
///         sold here: a pledge is only as good as the meter that bills it.
///
///         Where a bond is set, a seller must also have at least `bond` $LUX
///         locked in the locker, for at least `bondDays` more days counted from
///         the moment of listing. The lock is checked when the pledge is listed
///         and again when it is bought, when it must also still be running. The bond is the seller's own locked
///         tokens and stays theirs: this contract never holds it, cannot take
///         it, and does not need it for `cancel` or `collect`. One lock serves
///         every pledge its holder lists.
/// @dev    This contract never holds money. The price moves buyer to seller and
///         buyer to treasury with transferFrom. Money a pledge pays out before
///         it is sold lands in that wallet's own PledgeEscrow and is the
///         seller's, to be taken with `collect`, or sent to them by `buy` and
///         `cancel`.
///         The guardian can stop new listings and purchases for at most seven
///         days at a time, and start them again. A stop runs out by itself, so
///         a guardian key that is lost cannot halt the market for good (one
///         that is stolen can renew the stop for as long as it is held). It
///         can do nothing else: `cancel` and `collect` work while stopped, and
///         no call lets the guardian move a pledge or a unit of USDG. Nothing
///         here can be changed after it is made.
///         A purchase never fails because of the treasury: if USDG will not
///         deliver the fee there, the fee goes to the seller.
///         Threat model: the seller is untrusted towards the buyer, everything
///         off chain is untrusted, and the wallet is trusted only because it is
///         a wallet of the one factory named at construction.
///         What this contract cannot do for a buyer is written in the notes on
///         `buy`.
contract ZeroLuxMarket {
    uint16 public constant MAX_FEE_BPS = 500; // 5%
    uint256 public constant MAX_PAUSE = 7 days; // the longest a stop can run without being renewed

    address public immutable factory;
    address public immutable usdg;
    address public immutable guardian;
    uint16 public immutable feeBps; // share of the price that goes to the factory's treasury
    address public immutable locker; // where a seller's $LUX bond is locked; zero = no bond asked
    uint256 public immutable bond; // $LUX a seller must have locked to list; zero = no bond asked
    uint32 public immutable bondDays; // how long past the listing that lock must run

    uint64 public pausedUntil; // guardian switch: no new listings or purchases before this time

    struct Listing {
        address seller; // zero = not listed
        uint16 bps; // share of profit pledged, in hundredths of a percent
        uint128 price; // in USDG units
        uint128 cap; // most the pledge will ever pay; 0 = no cap
        uint256 baseProfit; // the pledge's starting point on the wallet, to tell it from a later one
        uint64 bondUntil; // the seller's bond must be locked to this time or later; 0 = no bond asked
    }

    /// What a page needs about one wallet, in one call.
    struct Offer {
        address seller;
        uint128 price;
        uint16 bps;
        uint128 cap;
        uint256 baseProfit; // the pledge earns on settled profit above this
        bool active; // listed
        bool buyable; // a purchase at these terms would pass every check right now
        uint256 fee; // what the treasury takes of the price
        address escrow; // the payee the owner pledges to
        uint128 paid; // how much of the cap is already used
        uint256 unpaid; // earned and not yet paid out: the seller's if sold now
        uint256 escrowBalance; // paid out before the sale and waiting for the seller
        address customOperator; // the wallet's own meter, zero = the factory's
        bool walletPaused; // the owner has stopped new runs
        bool bondMet; // listed: the seller's bond still stands; not listed: the owner could list now
        uint64 bondUntil; // listed: the time the seller's bond must be locked to; 0 = no bond asked
    }

    mapping(address wallet => Listing) private _listings;
    uint256 private _lock = 1;

    event Listed(
        address indexed wallet, address indexed seller, uint128 price, uint16 bps, uint128 cap, uint256 baseProfit
    );
    event Cancelled(address indexed wallet, address indexed owner, uint256 returned);
    event Sold(
        address indexed wallet,
        address indexed seller,
        address indexed buyer,
        uint128 price,
        uint256 fee,
        uint16 bps,
        uint128 cap,
        uint256 presale
    );
    event Collected(address indexed wallet, address indexed to, uint256 amount);
    event FeeRedirected(address indexed wallet, address indexed treasury, address indexed seller, uint256 fee);
    event PausedUntilSet(uint64 pausedUntil);

    error ZeroAddress();
    error FeeTooHigh();
    error NotGuardian();
    error MarketPaused();
    error Reentrancy();
    error NotAgentWallet();
    error NotOwner();
    error NotPledged();
    error NotListed();
    error TermsMismatch();
    error OwnerChanged();
    error PledgeChanged();
    error PaidTooHigh();
    error BaseTooHigh();
    error CustomOperator();
    error PauseTooLong();
    error ZeroPrice();
    error TransferFailed();
    error LockerNotAContract();
    error BondDaysTooLong();
    error BondMissing(); // the seller has less than `bond` locked, or the lock is over
    error BondTooShort(); // the seller's lock ends before the listing's bond time

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param locker_   the LuxLocker a seller's bond is read from
    /// @param bond_     $LUX a seller must have locked there to list
    /// @param bondDays_ days past the listing that lock must still run
    ///        With `locker_` zero or `bond_` zero no bond is asked of anyone.
    constructor(address factory_, address guardian_, uint16 feeBps_, address locker_, uint256 bond_, uint32 bondDays_) {
        if (factory_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (locker_ != address(0) && bond_ != 0) {
            if (locker_.code.length == 0) revert LockerNotAContract();
            // A lock cannot be made longer than the locker allows, so a longer
            // bond could never be met and nothing could ever be listed.
            if (uint256(bondDays_) * 1 days > IMarketLocker(locker_).MAX_LOCK()) revert BondDaysTooLong();
        }
        factory = factory_;
        guardian = guardian_;
        feeBps = feeBps_;
        locker = locker_;
        bond = bond_;
        bondDays = bondDays_;
        usdg = IMarketFactoryV3(factory_).usdg();
    }

    // ---- guardian ----

    /// @notice Stop new listings and purchases until `until`, at most seven days
    ///         from now, or restart them by naming a time that has passed (zero
    ///         will do). Nothing else.
    function setPausedUntil(uint64 until) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (until > block.timestamp + MAX_PAUSE) revert PauseTooLong();
        pausedUntil = until;
        emit PausedUntilSet(until);
    }

    function paused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    // ---- seller ----

    /// @notice Offer the pledge on `wallet` for `price`. The caller must own the
    ///         wallet, the wallet must be metered by the factory's operator, and
    ///         it must already be pledged to `escrowOf(wallet)` with exactly this
    ///         share and cap. Where a bond is set, the caller must have it locked
    ///         for at least `bondDays` more days. Listing again replaces the price
    ///         and counts the bond's days from now.
    function list(address wallet, uint128 price, uint16 bps, uint128 cap) external nonReentrant {
        if (paused()) revert MarketPaused();
        if (price == 0) revert ZeroPrice();
        if (!IMarketFactoryV3(factory).isAgentWallet(wallet)) revert NotAgentWallet();
        if (msg.sender != IMarketWalletV3(wallet).owner()) revert NotOwner();
        if (IMarketWalletV3(wallet).customOperator() != address(0)) revert CustomOperator();
        PledgeEscrow e = _escrow(wallet);
        (address payee, uint16 lbps, uint128 lcap,, uint256 base) = IMarketWalletV3(wallet).lien();
        if (payee != address(e)) revert NotPledged();
        if (lbps != bps || lcap != cap) revert TermsMismatch();
        uint64 bondUntil;
        if (bondOn()) {
            bondUntil = uint64(block.timestamp + uint256(bondDays) * 1 days);
            _checkBond(msg.sender, bondUntil);
        }
        _listings[wallet] = Listing(msg.sender, bps, price, cap, base, bondUntil);
        emit Listed(wallet, msg.sender, price, bps, cap, base);
    }

    /// @notice Take a pledge off the market and end it on the wallet. Only the
    ///         wallet's owner of the moment may: a seller who no longer owns the
    ///         wallet has no say. What the pledge paid into the escrow goes to
    ///         the caller. Also the way out for an owner who pledged to the
    ///         escrow and never listed. Works while paused, and asks no bond.
    function cancel(address wallet) external nonReentrant {
        if (!IMarketFactoryV3(factory).isAgentWallet(wallet)) revert NotAgentWallet();
        if (msg.sender != IMarketWalletV3(wallet).owner()) revert NotOwner();
        delete _listings[wallet];
        PledgeEscrow e = _escrow(wallet);
        (address payee,,,,) = IMarketWalletV3(wallet).lien();
        if (payee == address(e)) {
            // Collect first if USDG allows it. If it does not, the share stays in the
            // wallet, and the pledge is ended all the same.
            try IMarketWalletV3(wallet).settleLien() {} catch {}
            e.release(wallet);
        }
        // If USDG will not deliver to the owner the money waits in the escrow for `collect`.
        uint256 returned = _sweep(wallet, e, msg.sender, false);
        emit Cancelled(wallet, msg.sender, returned);
    }

    /// @notice Send what the wallet's pledge paid into its escrow to `to`. Only
    ///         the wallet's owner of the moment may, listed or not. Works while
    ///         paused, and asks no bond.
    function collect(address wallet, address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        if (!IMarketFactoryV3(factory).isAgentWallet(wallet)) revert NotAgentWallet();
        if (msg.sender != IMarketWalletV3(wallet).owner()) revert NotOwner();
        amount = _sweep(wallet, _escrow(wallet), to, true);
        emit Collected(wallet, to, amount);
    }

    // ---- buyer ----

    /// @notice Buy the pledge on `wallet`. The caller names the price, share and
    ///         cap they expect, the most of the cap they accept as already used
    ///         (`maxPaid`; a pledge keeps counting what it paid the seller), and
    ///         the highest starting profit they accept (`maxBase`; a pledge earns
    ///         only on profit above the figure it began at, so a seller who
    ///         ends a pledge and makes it again on the same terms has moved that
    ///         figure up past profit the buyer was counting on).
    ///         The call fails if the listing differs, if the wallet has changed
    ///         hands since it was listed, if it has its own meter, if the
    ///         pledge on the wallet is not the one that was listed, or if the
    ///         seller no longer has the bond locked to the time fixed when the
    ///         pledge was listed, or that lock is over (taken out or not). The caller
    ///         must have approved `price`, and never pays more than `price`.
    ///         The buyer becomes the pledge's payee and holds every right the
    ///         wallet gives a payee: to be paid, to point the pledge elsewhere,
    ///         to release it, and to refuse a change of meter, of terms or of
    ///         the wallets a run may pay.
    /// @dev    A sale is final. This contract cannot make the agent earn. The
    ///         owner can still pause the wallet, lower its limits or send
    ///         customers elsewhere, and the pledge pays only on profit the
    ///         wallet has settled, above the profit it had when the pledge was
    ///         made. A share earned and not collected shrinks if later runs
    ///         lose money, so collect often.
    function buy(address wallet, uint128 price, uint16 bps, uint128 cap, uint128 maxPaid, uint256 maxBase)
        external
        nonReentrant
    {
        if (paused()) revert MarketPaused();
        Listing memory l = _listings[wallet];
        if (l.seller == address(0)) revert NotListed();
        if (l.price != price || l.bps != bps || l.cap != cap) revert TermsMismatch();
        if (l.baseProfit > maxBase) revert BaseTooHigh();
        if (IMarketWalletV3(wallet).owner() != l.seller) revert OwnerChanged();
        if (IMarketWalletV3(wallet).customOperator() != address(0)) revert CustomOperator();
        PledgeEscrow e = PledgeEscrow(escrowOf(wallet));
        if (!_pledged(wallet, address(e), l)) revert PledgeChanged();
        if (l.bondUntil != 0) _checkBond(l.seller, l.bondUntil);

        // What the pledge has earned so far is the seller's: have the wallet pay it
        // into the escrow now. The wallet is this factory's own code, and the lock
        // above covers the call.
        IMarketWalletV3(wallet).settleLien();
        if (_paidOf(wallet) > maxPaid) revert PaidTooHigh();

        delete _listings[wallet];

        e.handOver(wallet, msg.sender);
        uint256 presale = _sweep(wallet, e, l.seller, true);
        uint256 fee = _payPrice(wallet, l.seller, l.price);
        emit Sold(wallet, l.seller, msg.sender, l.price, fee, l.bps, l.cap, presale);
    }

    // ---- views ----

    /// @notice The address the owner of `wallet` pledges to before listing. It is
    ///         the same before and after the escrow is made.
    function escrowOf(address wallet) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff), address(this), bytes32(uint256(uint160(wallet))), keccak256(type(PledgeEscrow).creationCode)
            )
        );
        return address(uint160(uint256(h)));
    }

    /// @notice Whether this market asks sellers for a bond at all.
    function bondOn() public view returns (bool) {
        return locker != address(0) && bond != 0;
    }

    /// @notice Whether `account` could list right now as far as the bond goes:
    ///         it has at least `bond` locked for at least `bondDays` more days.
    ///         Always true where no bond is asked.
    function bondReady(address account) public view returns (bool) {
        if (!bondOn()) return true;
        return _bondMet(account, uint64(block.timestamp + uint256(bondDays) * 1 days));
    }

    function listing(address wallet)
        external
        view
        returns (address seller, uint128 price, uint16 bps, uint128 cap, bool active)
    {
        Listing memory l = _listings[wallet];
        return (l.seller, l.price, l.bps, l.cap, l.seller != address(0));
    }

    /// @notice The listing and the state of the pledge behind it. For a wallet
    ///         that is not this factory's, only the escrow address is filled in.
    function offer(address wallet) external view returns (Offer memory o) {
        Listing memory l = _listings[wallet];
        o.escrow = escrowOf(wallet);
        o.escrowBalance = IMarketERC20(usdg).balanceOf(o.escrow);
        if (!IMarketFactoryV3(factory).isAgentWallet(wallet)) return o;
        o.seller = l.seller;
        o.price = l.price;
        o.bps = l.bps;
        o.cap = l.cap;
        o.baseProfit = l.baseProfit;
        o.active = l.seller != address(0);
        o.fee = (uint256(l.price) * feeBps) / 10_000;
        (address payee,,, uint128 paid,) = IMarketWalletV3(wallet).lien();
        if (payee == o.escrow) {
            o.paid = paid;
            o.unpaid = IMarketWalletV3(wallet).lienUnpaid();
        }
        o.customOperator = IMarketWalletV3(wallet).customOperator();
        o.walletPaused = IMarketWalletV3(wallet).paused();
        address owner = IMarketWalletV3(wallet).owner();
        o.bondUntil = l.bondUntil;
        if (!o.active) o.bondMet = bondReady(owner);
        else o.bondMet = l.bondUntil == 0 || _bondMet(l.seller, l.bondUntil);
        o.buyable = o.active && !paused() && o.customOperator == address(0) && owner == l.seller
            && _pledged(wallet, o.escrow, l) && o.bondMet;
    }

    // ---- internals ----

    /// @dev The pledge on the wallet is the one that was listed, and the escrow is its payee.
    function _pledged(address wallet, address escrow, Listing memory l) private view returns (bool) {
        (address payee, uint16 bps, uint128 cap,, uint256 base) = IMarketWalletV3(wallet).lien();
        return payee == escrow && bps == l.bps && cap == l.cap && base == l.baseProfit;
    }

    /// @dev `who` has at least `bond` in a lock that ends at `until` or later
    ///      and that is still running now: a lock that is over counts as
    ///      nothing, whether or not the tokens have been taken out.
    function _bondMet(address who, uint64 until) private view returns (bool) {
        (uint256 amount, uint64 unlockAt) = IMarketLocker(locker).locked(who);
        return amount >= bond && unlockAt >= until && IMarketLocker(locker).lockedOf(who) >= bond;
    }

    /// @dev The same rule as `_bondMet`, failing with the reason.
    function _checkBond(address who, uint64 until) private view {
        (uint256 amount, uint64 unlockAt) = IMarketLocker(locker).locked(who);
        if (amount < bond) revert BondMissing();
        if (unlockAt < until) revert BondTooShort();
        if (IMarketLocker(locker).lockedOf(who) < bond) revert BondMissing();
    }

    function _paidOf(address wallet) private view returns (uint128 paid) {
        (,,, paid,) = IMarketWalletV3(wallet).lien();
    }

    /// @dev Take `price` from the buyer and no more: the seller's part to the
    ///      seller, the fee to the factory's treasury. If USDG will not deliver
    ///      the fee to the treasury it goes to the seller, so the treasury can
    ///      never stand in the way of a sale. Returns what the treasury received.
    function _payPrice(address wallet, address seller, uint128 price) private returns (uint256 fee) {
        fee = (uint256(price) * feeBps) / 10_000;
        _pull(msg.sender, seller, price - fee);
        if (fee == 0) return 0;
        address to = IMarketFactoryV3(factory).treasury();
        uint256 before = IMarketERC20(usdg).balanceOf(msg.sender);
        if (_tryPull(msg.sender, to, fee)) return fee;
        // A transfer that says it failed must have moved nothing, or the buyer
        // would pay the fee twice.
        if (IMarketERC20(usdg).balanceOf(msg.sender) != before) revert TransferFailed();
        _pull(msg.sender, seller, fee);
        emit FeeRedirected(wallet, to, seller, fee);
        return 0;
    }

    /// @dev The wallet's escrow, made on first use.
    function _escrow(address wallet) private returns (PledgeEscrow e) {
        e = PledgeEscrow(escrowOf(wallet));
        if (address(e).code.length == 0) {
            PledgeEscrow made = new PledgeEscrow{salt: bytes32(uint256(uint160(wallet)))}();
            assert(made == e);
        }
    }

    /// @dev Move everything in the wallet's escrow to `to`, first bringing in
    ///      anything the wallet had to set aside for the escrow.
    function _sweep(address wallet, PledgeEscrow e, address to, bool strict) private returns (uint256) {
        if (IMarketWalletV3(wallet).parked(address(e)) != 0) {
            try e.claimParked(wallet) {} catch {}
        }
        return e.sweep(usdg, to, strict);
    }

    /// @dev Move exactly `amount` of USDG that `from` has approved to this contract, or fail.
    function _pull(address from, address to, uint256 amount) private {
        if (!_tryPull(from, to, amount)) revert TransferFailed();
    }

    function _tryPull(address from, address to, uint256 amount) private returns (bool) {
        // transferFrom(address,address,uint256)
        (bool ok, bytes memory ret) = usdg.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (uint256)) == 1)) && usdg.code.length != 0;
    }
}
