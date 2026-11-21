// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactoryV3} from "../src/ZeroLuxFactoryV3.sol";
import {AgentWalletV3} from "../src/AgentWalletV3.sol";
import {ZeroLuxMarket} from "../src/ZeroLuxMarket.sol";
import {MockUSDGV3} from "./V3.t.sol";

/// Drives the market and two real wallets with bounded random actions: owners
/// pledge, list, cancel and collect, backers buy, customers pay, the meter
/// bills, anyone settles, the guardian pauses, wallets change hands, the
/// factory's treasury changes and USDG blocks and unblocks the parties.
/// No action reverts: each one goes through, returns early, or (where a block
/// can make the market refuse) is tried and its refusal checked, so the test
/// runs with fail-on-revert switched on. Every sale, cancel and collect is
/// checked to the unit where it happens.
contract MarketHandler is Test {
    MockUSDGV3 public usdg;
    ZeroLuxFactoryV3 public factory;
    ZeroLuxMarket public market;
    AgentWalletV3[2] public wallets;
    address[3] public ownerPool; // every address that may come to own a wallet
    address[2] public buyers;
    address[2] public treasuries; // [0] is the one the wallets bill to; the factory's moves between the two
    address public customer = makeAddr("minv-customer");
    address public admin;
    address public operator;
    address public guardian;
    address internal stranger = makeAddr("minv-stranger");

    uint256 public sales;
    uint256 public salesFeeRedirected;
    uint256 public salesRefused;
    uint256 public cancels;
    uint256 public collects;
    uint256 public handovers;
    uint256 public paidOutToBuyers;
    uint256 internal runSeq;
    uint256 internal nonceSeq;

    constructor(
        MockUSDGV3 usdg_,
        ZeroLuxFactoryV3 factory_,
        ZeroLuxMarket market_,
        address admin_,
        address operator_,
        address treasury_,
        address guardian_
    ) {
        usdg = usdg_;
        factory = factory_;
        market = market_;
        admin = admin_;
        operator = operator_;
        guardian = guardian_;
        treasuries = [treasury_, makeAddr("minv-treasury2")];
        ownerPool = [makeAddr("minv-owner0"), makeAddr("minv-owner1"), makeAddr("minv-owner2")];
        buyers = [makeAddr("minv-buyer0"), makeAddr("minv-buyer1")];
        for (uint256 i; i < 2; i++) {
            (, address w) = factory_.createAgent(ownerPool[i], 10e6, 500e6, keccak256("spec"), "", treasury_, 2_000);
            wallets[i] = AgentWalletV3(w);
            vm.prank(buyers[i]);
            usdg_.approve(address(market_), type(uint256).max);
        }
    }

    function _payee(AgentWalletV3 w) internal view returns (address payee) {
        (payee,,,,) = w.lien();
    }

    function _isBuyer(address who) internal view returns (bool) {
        return who == buyers[0] || who == buyers[1];
    }

    /// What `settleLien` would move right now.
    function _wouldSettle(AgentWalletV3 w) internal view returns (uint256 amount) {
        if (_payee(w) == address(0)) return 0;
        amount = w.lienUnpaid();
        uint256 bal = usdg.balanceOf(address(w));
        uint256 spoken = w.parkedTotal() + w.heldTotal();
        bal = bal > spoken ? bal - spoken : 0;
        if (amount > bal) amount = bal;
    }

    /// What reaches the escrow when the market gathers for it: what the wallet set
    /// aside for it and, if the pledge is still the escrow's, what it is owed.
    /// Nothing if USDG will not deliver to the escrow.
    function _incoming(AgentWalletV3 w, address e) internal view returns (uint256) {
        if (usdg.blocked(e)) return 0;
        return w.parked(e) + (_payee(w) == e ? _wouldSettle(w) : 0);
    }

    // ---- owners ----

    function pledgeAndList(uint256 seed, uint16 bps, uint128 cap, uint128 price) external {
        pledge(seed, bps, cap);
        list(seed, price);
    }

    function pledge(uint256 seed, uint16 bps, uint128 cap) public {
        AgentWalletV3 w = wallets[seed % 2];
        if (_payee(w) != address(0) || w.plainHolds() != 0) return;
        bps = uint16(bound(bps, 1, 10_000));
        cap = uint128(bound(cap, 0, 30e6));
        address e = market.escrowOf(address(w));
        address owner_ = w.owner();
        vm.prank(owner_);
        w.setLien(e, bps, cap);
    }

    function list(uint256 seed, uint128 price) public {
        AgentWalletV3 w = wallets[seed % 2];
        if (market.paused() || _payee(w) != market.escrowOf(address(w))) return;
        price = uint128(bound(price, 1, 500e6));
        (, uint16 bps, uint128 cap,,) = w.lien();
        address owner_ = w.owner();
        vm.prank(owner_);
        market.list(address(w), price, bps, cap);
        (address seller,,,,) = market.listing(address(w));
        assertEq(seller, owner_);
    }

    function cancel(uint256 seed, uint256 rarely) external {
        if (rarely % 4 != 0) return; // leave listings standing long enough to be bought
        AgentWalletV3 w = wallets[seed % 2];
        address e = market.escrowOf(address(w));
        address owner_ = w.owner();
        bool pledged = _payee(w) == e;
        address payeeAfter = pledged ? address(0) : _payee(w);
        uint256 pot = usdg.balanceOf(e) + _incoming(w, e);
        uint256 due = (usdg.blocked(e) || usdg.blocked(owner_)) ? 0 : pot;
        uint256 before = usdg.balanceOf(owner_);

        vm.prank(owner_);
        market.cancel(address(w));

        assertEq(usdg.balanceOf(owner_) - before, due, "owner has all the pledge paid before any sale");
        assertEq(usdg.balanceOf(e), pot - due, "what could not be delivered waits in the escrow");
        assertEq(_payee(w), payeeAfter, "an unsold pledge is ended whatever USDG does; a sold one is untouched");
        (,,,, bool active) = market.listing(address(w));
        assertFalse(active);
        cancels++;
    }

    function collect(uint256 seed) external {
        AgentWalletV3 w = wallets[seed % 2];
        address e = market.escrowOf(address(w));
        address owner_ = w.owner();
        uint256 pot = usdg.balanceOf(e) + (usdg.blocked(e) ? 0 : w.parked(e));
        uint256 before = usdg.balanceOf(owner_);
        vm.prank(owner_);
        try market.collect(address(w), owner_) returns (uint256 amount) {
            assertEq(amount, pot);
            assertEq(usdg.balanceOf(owner_) - before, pot);
            assertEq(usdg.balanceOf(e), 0);
            collects++;
        } catch {
            assertTrue(pot != 0 && (usdg.blocked(e) || usdg.blocked(owner_)), "collect refused without a block");
        }
    }

    /// The wallet changes hands. Its listing, if any, stops being buyable until the new owner lists.
    function handOver(uint256 seed, uint256 toSeed) external {
        AgentWalletV3 w = wallets[seed % 2];
        address from = w.owner();
        address to = ownerPool[toSeed % 3];
        if (to == from) return;
        (address seller,,,, bool active) = market.listing(address(w));
        vm.prank(from);
        w.transferOwnership(to);
        vm.prank(to);
        w.acceptOwnership();
        if (active && seller != to) assertFalse(market.offer(address(w)).buyable, "a stale listing is not for sale");
        // The one who left has no say any more.
        vm.prank(from);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.cancel(address(w));
        vm.prank(from);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.collect(address(w), from);
        handovers++;
    }

    /// The owner ends a pledge that has paid its cap, listed or not.
    function ownerEndsAtCap(uint256 seed) external {
        AgentWalletV3 w = wallets[seed % 2];
        address owner_ = w.owner();
        vm.prank(owner_);
        try w.endLien() {} catch {}
    }

    // ---- backers ----

    struct Before {
        uint256 seller;
        uint256 buyer;
        uint256 treasury;
        uint256 presale;
    }

    function buy(uint256 seed, uint256 buyerSeed) external {
        AgentWalletV3 w = wallets[seed % 2];
        ZeroLuxMarket.Offer memory o = market.offer(address(w));
        if (!o.buyable) return;
        address buyer = buyers[buyerSeed % 2];
        address treasury = factory.treasury();
        usdg.mint(buyer, o.price);

        Before memory b = Before(
            usdg.balanceOf(o.seller),
            usdg.balanceOf(buyer),
            usdg.balanceOf(treasury),
            o.escrowBalance + _incoming(w, o.escrow)
        );
        // USDG stands in the way only if it will not deliver to the seller, will not
        // take from the buyer, or will not move what the seller is owed through the escrow.
        bool mustFail = usdg.blocked(o.seller) || usdg.blocked(buyer)
            || (usdg.blocked(o.escrow) && (o.escrowBalance != 0 || _wouldSettle(w) != 0));

        vm.prank(buyer);
        try market.buy(address(w), o.price, o.bps, o.cap, type(uint128).max, o.baseProfit) {
            assertFalse(mustFail, "a sale went through a block");
        } catch {
            assertTrue(mustFail, "a sale was refused with nothing in its way");
            assertEq(usdg.balanceOf(buyer), b.buyer, "a refused buyer paid nothing");
            assertEq(_payee(w), o.escrow);
            salesRefused++;
            return;
        }

        uint256 fee = (uint256(o.price) * 250) / 10_000;
        assertEq(o.fee, fee, "fee as shown");
        if (usdg.blocked(treasury)) {
            // A treasury USDG will not pay never stops a sale: its fee is the seller's.
            assertEq(usdg.balanceOf(treasury), b.treasury);
            fee = 0;
            salesFeeRedirected++;
        } else {
            assertEq(usdg.balanceOf(treasury) - b.treasury, fee, "treasury: the fee");
        }
        assertEq(usdg.balanceOf(o.seller) - b.seller, b.presale + o.price - fee, "seller: price less fee, plus the earlier share");
        assertEq(b.buyer - usdg.balanceOf(buyer), o.price, "buyer: the price, no more");
        assertEq(_payee(w), buyer, "buyer is the payee");
        assertEq(usdg.balanceOf(o.escrow), 0, "escrow is empty after a sale");
        assertEq(w.lienUnpaid(), 0, "nothing earlier is left for the buyer to take");
        assertEq(w.owner(), o.seller, "only the owner of the moment sells");
        (,,,, bool active) = market.listing(address(w));
        assertFalse(active);
        sales++;
    }

    /// A buyer lets go of a pledge, so the owner can pledge afresh.
    function buyerReleases(uint256 seed) external {
        AgentWalletV3 w = wallets[seed % 2];
        address payee = _payee(w);
        if (!_isBuyer(payee)) return;
        vm.prank(payee);
        w.endLien();
    }

    // ---- everyone else ----

    /// A customer pays through `pay` and the meter bills the run.
    function earn(uint256 seed, uint256 cost) external {
        AgentWalletV3 w = wallets[seed % 2];
        if (factory.operatorPaused() || w.paused() || w.remainingToday() < 6e6) return;
        if (usdg.blocked(treasuries[0])) return; // the wallets bill to it
        cost = bound(cost, 1, 5e6);
        bytes32 id = keccak256(abi.encode("minv-run", ++runSeq));
        usdg.mint(customer, 6e6);
        vm.prank(operator);
        w.pay(customer, 6e6, 0, block.timestamp + 600, bytes32(++nonceSeq), 27, bytes32(0), bytes32(0), id, 5e6, false);
        vm.prank(operator);
        w.chargeAndSettle(id, cost, type(uint256).max, keccak256("receipt"));
    }

    /// Anyone sends the payee its share.
    function settle(uint256 seed) external {
        AgentWalletV3 w = wallets[seed % 2];
        address payee = _payee(w);
        if (payee == address(0)) return;
        vm.prank(stranger);
        try w.settleLien() returns (uint256 amount) {
            if (_isBuyer(payee)) paidOutToBuyers += amount;
        } catch {
            assertTrue(usdg.blocked(payee), "a payout failed without a block");
        }
    }

    function pause(uint64 until, uint256 rarely) external {
        until = rarely % 4 == 0 ? uint64(bound(until, block.timestamp, block.timestamp + 7 days)) : 0;
        vm.prank(guardian);
        market.setPausedUntil(until);
    }

    /// The factory moves its treasury (two days' notice). The fee follows it.
    function changeTreasury(uint256 seed) external {
        address to = treasuries[seed % 2];
        if (to == factory.treasury()) return;
        vm.prank(admin);
        factory.proposeTreasury(to);
        skip(2 days);
        vm.prank(admin);
        factory.acceptTreasury();
    }

    /// USDG blocks or unblocks an owner, a buyer, an escrow or a treasury.
    function block_(uint256 seed, bool on, uint256 rarely) external {
        if (on && rarely % 3 != 0) return; // blocks are the exception, not the rule
        uint256 k = seed % 9;
        address who = k < 3
            ? ownerPool[k]
            : k < 5 ? buyers[k - 3] : k < 7 ? market.escrowOf(address(wallets[k - 5])) : treasuries[k - 7];
        usdg.setBlocked(who, on);
    }

    function skipTime(uint32 secs) external {
        skip(bound(secs, 1, 12 hours));
    }

    function total() external view returns (uint256 sum) {
        sum = usdg.balanceOf(address(market)) + usdg.balanceOf(customer) + usdg.balanceOf(guardian)
            + usdg.balanceOf(stranger) + usdg.balanceOf(ownerPool[2]);
        for (uint256 i; i < 2; i++) {
            sum += usdg.balanceOf(address(wallets[i])) + usdg.balanceOf(ownerPool[i]) + usdg.balanceOf(buyers[i])
                + usdg.balanceOf(treasuries[i]) + usdg.balanceOf(market.escrowOf(address(wallets[i])));
        }
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = true
contract MarketInvariantTest is Test {
    MockUSDGV3 usdg;
    ZeroLuxFactoryV3 factory;
    ZeroLuxMarket market;
    MarketHandler handler;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDGV3();
        factory = new ZeroLuxFactoryV3(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        market = new ZeroLuxMarket(address(factory), guardian, 250, address(0), 0, 0);
        handler = new MarketHandler(usdg, factory, market, admin, operator, treasury, guardian);
        targetContract(address(handler));
    }

    function invariant_1_the_market_never_holds_usdg() public view {
        assertEq(usdg.balanceOf(address(market)), 0);
    }

    function invariant_2_the_guardian_never_gains_anything() public view {
        assertEq(usdg.balanceOf(guardian), 0);
    }

    function invariant_3_usdg_is_conserved_across_everyone_involved() public view {
        assertEq(handler.total(), usdg.minted());
    }

    function invariant_4_a_sold_pledge_leaves_nothing_behind_in_the_escrow_unless_usdg_held_it_there() public view {
        // A wallet whose pledge is with a buyer has an empty escrow: everything from
        // before the sale went to the seller in the sale. (A buyer who is paid there
        // by pointing the pledge back is not something the handler does.)
        for (uint256 i; i < 2; i++) {
            AgentWalletV3 w = handler.wallets(i);
            (address payee,,,,) = w.lien();
            if (payee == handler.buyers(0) || payee == handler.buyers(1)) {
                assertEq(usdg.balanceOf(market.escrowOf(address(w))), 0);
            }
        }
    }

    function invariant_5_a_listing_that_shows_buyable_is_its_owners_and_has_its_pledge_with_the_escrow() public view {
        for (uint256 i; i < 2; i++) {
            AgentWalletV3 w = handler.wallets(i);
            ZeroLuxMarket.Offer memory o = market.offer(address(w));
            if (!o.buyable) continue;
            (address payee, uint16 bps, uint128 cap,, uint256 base) = w.lien();
            assertEq(payee, o.escrow);
            assertEq(bps, o.bps);
            assertEq(cap, o.cap);
            assertEq(base, o.baseProfit);
            assertEq(w.owner(), o.seller);
            assertEq(w.customOperator(), address(0));
            assertFalse(market.paused());
        }
    }

    function invariant_6_a_pause_never_reaches_more_than_seven_days_ahead() public view {
        assertLe(market.pausedUntil(), block.timestamp + 7 days);
    }

    /// Not a property: shows (with -vv) what the last run exercised.
    function afterInvariant() public {
        emit log_named_uint("sales", handler.sales());
        emit log_named_uint("sales with the fee redirected", handler.salesFeeRedirected());
        emit log_named_uint("sales refused by a block", handler.salesRefused());
        emit log_named_uint("cancels", handler.cancels());
        emit log_named_uint("collects", handler.collects());
        emit log_named_uint("handovers", handler.handovers());
        emit log_named_uint("paid out to buyers", handler.paidOutToBuyers());
    }
}
