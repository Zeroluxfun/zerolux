// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {ZeroLuxFactoryV3} from "../src/ZeroLuxFactoryV3.sol";
import {AgentWalletV3} from "../src/AgentWalletV3.sol";
import {ZeroLuxMarket, PledgeEscrow} from "../src/ZeroLuxMarket.sol";
import {V3Base} from "./V3.t.sol";
import {LuxLocker} from "../src/LuxLocker.sol";
import {MockLux} from "./LuxLocker.t.sol";

/// The market against the real version 3 factory and wallets, with the same
/// USDG stand-in the version 3 tests use.
abstract contract MarketBase is V3Base {
    ZeroLuxMarket market;
    address backer = makeAddr("backer");
    address backer2 = makeAddr("backer2");

    uint16 constant BPS = 2_500;
    uint128 constant CAP = 3e6;
    uint128 constant PRICE = 100e6;
    uint16 constant FEE = 250;
    uint128 constant ANY = type(uint128).max;
    uint256 constant NOBASE = type(uint256).max;

    uint256 internal runSeq;

    function setUp() public virtual override {
        super.setUp();
        market = new ZeroLuxMarket(address(factory), guardian, FEE, address(0), 0, 0);
        usdg.mint(backer, 1_000e6);
        usdg.mint(backer2, 1_000e6);
    }

    function _escrow(AgentWalletV3 w) internal view returns (address) {
        return market.escrowOf(address(w));
    }

    function _pledge(AgentWalletV3 w, address owner_) internal {
        address e = _escrow(w); // read first: the next call must be the owner's
        vm.prank(owner_);
        w.setLien(e, BPS, CAP);
    }

    function _pledgeAndList(AgentWalletV3 w, address owner_) internal {
        _pledge(w, owner_);
        vm.prank(owner_);
        market.list(address(w), PRICE, BPS, CAP);
    }

    function _buy(AgentWalletV3 w, address who) internal {
        vm.prank(who);
        usdg.approve(address(market), PRICE);
        vm.prank(who);
        market.buy(address(w), PRICE, BPS, CAP, ANY, NOBASE);
    }

    /// One customer run through the wallet's real pay and charge flow: $6 paid,
    /// $1 of cost and $0.20 of fee billed, so $4.80 of settled profit.
    function _earn(AgentWalletV3 w) internal {
        bytes32 id = keccak256(abi.encode("market-run", ++runSeq));
        _payTo(w, customer, 6e6, id, 5e6);
        vm.prank(operator);
        w.chargeAndSettle(id, 1e6, type(uint256).max, RCPT);
    }

    function _pause(bool on) internal {
        vm.prank(guardian);
        market.setPausedUntil(on ? uint64(block.timestamp + 7 days) : 0);
    }

    function _handTo(AgentWalletV3 w, address from, address to) internal {
        vm.prank(from);
        w.transferOwnership(to);
        vm.prank(to);
        w.acceptOwnership();
    }

    function _base(AgentWalletV3 w) internal view returns (uint256 base) {
        (,,,, base) = w.lien();
    }

    function _payee(AgentWalletV3 w) internal view returns (address payee) {
        (payee,,,,) = w.lien();
    }

    function _paid(AgentWalletV3 w) internal view returns (uint128 paid) {
        (,,, paid,) = w.lien();
    }
}

contract MarketTest is MarketBase {
    using stdStorage for StdStorage;

    event Listed(
        address indexed wallet, address indexed seller, uint128 price, uint16 bps, uint128 cap, uint256 baseProfit
    );
    event Cancelled(address indexed wallet, address indexed owner, uint256 returned);
    event FeeRedirected(address indexed wallet, address indexed treasury, address indexed seller, uint256 fee);
    event PausedUntilSet(uint64 pausedUntil);
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

    // ---- the whole path ----

    function test_list_buy_earn_and_the_payout_reaches_the_buyer_up_to_the_cap() public {
        _pledge(wallet, alice);
        vm.expectEmit(true, true, true, true, address(market));
        emit Listed(address(wallet), alice, PRICE, BPS, CAP, 0);
        vm.prank(alice);
        market.list(address(wallet), PRICE, BPS, CAP);

        (address seller, uint128 price, uint16 bps, uint128 cap, bool active) = market.listing(address(wallet));
        assertEq(seller, alice);
        assertEq(price, PRICE);
        assertEq(bps, BPS);
        assertEq(cap, CAP);
        assertTrue(active);

        uint256 treasuryBefore = usdg.balanceOf(treasury);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.expectEmit(true, true, true, true, address(market));
        emit Sold(address(wallet), alice, backer, PRICE, 2.5e6, BPS, CAP, 0);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, 0, NOBASE);

        assertEq(usdg.balanceOf(alice), 97.5e6, "seller has the price less the fee");
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, 2.5e6, "treasury has the fee");
        assertEq(usdg.balanceOf(backer), 900e6);
        assertEq(usdg.balanceOf(address(market)), 0, "the market holds nothing");
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);
        assertEq(_payee(wallet), backer, "the buyer is the pledge's payee");
        (,,,, active) = market.listing(address(wallet));
        assertFalse(active);

        // The agent earns through the wallet's own pay and charge flow.
        _earn(wallet);
        _earn(wallet);
        assertEq(wallet.lienUnpaid(), 2.4e6);
        vm.prank(mallory); // anyone may send the payee its share
        wallet.settleLien();
        assertEq(usdg.balanceOf(backer), 902.4e6);

        // Two more runs would earn another 2.4, but the cap leaves 0.6.
        _earn(wallet);
        _earn(wallet);
        assertEq(wallet.lienUnpaid(), 0.6e6);
        wallet.settleLien();
        assertEq(usdg.balanceOf(backer), 903e6);
        _earn(wallet);
        assertEq(wallet.lienUnpaid(), 0, "nothing past the cap");
        assertEq(wallet.settleLien(), 0);
        assertEq(usdg.balanceOf(backer), 903e6);
        assertEq(usdg.balanceOf(address(market)), 0);

        // The seller cannot cancel what is sold.
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), backer);
        assertEq(_paid(wallet), 3e6);

        // The pledge has paid its cap, so the owner may end it.
        vm.prank(alice);
        wallet.endLien();
        assertEq(_payee(wallet), address(0));
    }

    function test_the_owner_cannot_end_or_move_a_pledge_that_is_for_sale_or_sold() public {
        _pledgeAndList(wallet, alice);
        vm.prank(alice);
        vm.expectRevert(AgentWalletV3.LienStands.selector);
        wallet.endLien();
        vm.prank(alice);
        vm.expectRevert(AgentWalletV3.NotOwner.selector);
        wallet.setLienPayee(alice);
        vm.prank(alice);
        vm.expectRevert(AgentWalletV3.LienExists.selector);
        wallet.setOperator(alice);

        _buy(wallet, backer);
        vm.prank(alice);
        vm.expectRevert(AgentWalletV3.LienStands.selector);
        wallet.endLien();
        vm.prank(alice);
        vm.expectRevert(AgentWalletV3.NotOwner.selector);
        wallet.setLienPayee(alice);
        // The buyer holds a payee's rights: the meter cannot be swapped without them.
        vm.prank(alice);
        vm.expectRevert(AgentWalletV3.LienExists.selector);
        wallet.setOperator(alice);
        vm.prank(backer);
        wallet.setLienPayee(backer2);
        assertEq(_payee(wallet), backer2);
    }

    // ---- what was earned before the sale is the seller's ----

    function test_profit_settled_before_the_sale_goes_to_the_seller() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet); // 1.2 accrues to the pledge, still in the wallet
        assertEq(wallet.lienUnpaid(), 1.2e6);

        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.expectEmit(true, true, true, true, address(market));
        emit Sold(address(wallet), alice, backer, PRICE, 2.5e6, BPS, CAP, 1.2e6);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, 1.2e6, NOBASE);

        assertEq(usdg.balanceOf(alice), 97.5e6 + 1.2e6, "seller has the price and the earlier share");
        assertEq(usdg.balanceOf(backer), 900e6, "buyer has none of it");
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(usdg.balanceOf(address(market)), 0);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);

        _earn(wallet);
        wallet.settleLien();
        assertEq(usdg.balanceOf(backer), 901.2e6, "what comes after is the buyer's");
        assertEq(usdg.balanceOf(alice), 98.7e6);
    }

    function test_a_share_someone_already_paid_out_before_the_sale_goes_to_the_seller_too() public {
        _pledge(wallet, alice);
        _earn(wallet);
        vm.prank(mallory);
        wallet.settleLien(); // before the listing even exists
        assertEq(usdg.balanceOf(_escrow(wallet)), 1.2e6);
        vm.prank(alice);
        market.list(address(wallet), PRICE, BPS, CAP);
        _earn(wallet);
        vm.prank(mallory);
        wallet.settleLien(); // and after it
        assertEq(usdg.balanceOf(_escrow(wallet)), 2.4e6);

        ZeroLuxMarket.Offer memory o = market.offer(address(wallet));
        assertEq(o.paid, 2.4e6);
        assertEq(o.escrowBalance, 2.4e6);
        assertTrue(o.buyable);

        _buy(wallet, backer);
        assertEq(usdg.balanceOf(alice), 97.5e6 + 2.4e6);
        assertEq(usdg.balanceOf(backer), 900e6);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);
        assertEq(usdg.balanceOf(address(market)), 0);
    }

    function test_the_buyer_names_how_much_of_the_cap_may_already_be_used() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.PaidTooHigh.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, 1.2e6 - 1, NOBASE);
        assertEq(_payee(wallet), _escrow(wallet), "nothing moved");
        assertEq(usdg.balanceOf(backer), 1_000e6);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, 1.2e6, NOBASE);
        assertEq(_payee(wallet), backer);
    }

    function test_the_seller_can_collect_before_any_sale() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        wallet.settleLien();
        vm.prank(mallory);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.collect(address(wallet), mallory);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.ZeroAddress.selector);
        market.collect(address(wallet), address(0));
        vm.prank(alice);
        assertEq(market.collect(address(wallet), carol), 1.2e6);
        assertEq(usdg.balanceOf(carol), 1.2e6);
        assertEq(_payee(wallet), _escrow(wallet), "still for sale");
    }

    // ---- cancel ----

    function test_cancel_before_a_sale_ends_the_pledge() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        assertEq(wallet.withdrawable(), 4.8e6 - 1.2e6);

        vm.prank(mallory);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.cancel(address(wallet));

        vm.expectEmit(true, true, true, true, address(market));
        emit Cancelled(address(wallet), alice, 1.2e6);
        vm.prank(alice);
        market.cancel(address(wallet));

        assertEq(_payee(wallet), address(0), "the wallet is pledged to nobody");
        (,,,, bool active) = market.listing(address(wallet));
        assertFalse(active);
        assertEq(usdg.balanceOf(alice), 1.2e6, "the share it had earned is the seller's");
        assertEq(wallet.withdrawable(), 3.6e6, "and the rest is free");
        assertEq(usdg.balanceOf(address(market)), 0);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);

        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.NotListed.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);

        // And the owner can pledge again.
        _pledgeAndList(wallet, alice);
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
    }

    function test_an_owner_who_pledged_and_never_listed_can_still_get_out() public {
        _pledge(wallet, alice);
        _earn(wallet);
        wallet.settleLien();
        vm.prank(mallory);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.cancel(address(wallet));
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));
        assertEq(usdg.balanceOf(alice), 1.2e6);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);
    }

    function test_cancel_works_when_usdg_will_not_pay_the_escrow_or_the_seller() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        wallet.settleLien(); // 1.2 in the escrow
        _earn(wallet); // 1.2 more, unpaid
        usdg.setBlocked(alice, true);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0), "the pledge is ended all the same");
        assertEq(usdg.balanceOf(_escrow(wallet)), 2.4e6, "and the money waits");
        vm.prank(alice);
        assertEq(market.collect(address(wallet), carol), 2.4e6);
        assertEq(usdg.balanceOf(carol), 2.4e6);

        usdg.setBlocked(alice, false);
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        usdg.setBlocked(_escrow(wallet), true);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));
        assertEq(wallet.withdrawable(), _bal(wallet), "the uncollected share stayed in the wallet, free");
    }

    // ---- who may list, and what ----

    function test_cannot_list_a_wallet_that_is_not_the_factorys() public {
        FakeWallet fake = new FakeWallet(alice, market);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotAgentWallet.selector);
        market.list(address(fake), PRICE, BPS, CAP);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotAgentWallet.selector);
        market.cancel(address(fake));
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotAgentWallet.selector);
        market.collect(address(fake), alice);

        // A wallet of another factory is no better.
        ZeroLuxFactoryV3 other = new ZeroLuxFactoryV3(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        (, address w) = other.createAgent(alice, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000);
        address otherEscrow = market.escrowOf(w);
        vm.prank(alice);
        AgentWalletV3(w).setLien(otherEscrow, BPS, CAP);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotAgentWallet.selector);
        market.list(w, PRICE, BPS, CAP);
    }

    function test_cannot_list_as_someone_who_is_not_the_owner() public {
        _pledge(wallet, alice);
        vm.prank(mallory);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
        vm.prank(operator);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
    }

    function test_cannot_list_without_the_pledge_in_place() public {
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotPledged.selector);
        market.list(address(wallet), PRICE, BPS, CAP);

        // Pledged to someone the market does not control: the seller could pull it away.
        vm.prank(alice);
        wallet.setLien(alice, BPS, CAP);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotPledged.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
        vm.prank(alice);
        wallet.endLien();

        // Pledged to the market itself rather than the wallet's escrow.
        vm.prank(alice);
        wallet.setLien(address(market), BPS, CAP);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotPledged.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
    }

    function test_cannot_list_terms_the_pledge_does_not_have() public {
        _pledge(wallet, alice);
        vm.startPrank(alice);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.list(address(wallet), PRICE, BPS + 1, CAP);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.list(address(wallet), PRICE, BPS, CAP + 1);
        vm.expectRevert(ZeroLuxMarket.ZeroPrice.selector);
        market.list(address(wallet), 0, BPS, CAP);
        vm.stopPrank();
    }

    function test_listing_again_changes_the_price_and_the_old_price_no_longer_buys() public {
        _pledgeAndList(wallet, alice);
        vm.prank(backer);
        usdg.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.list(address(wallet), PRICE * 2, BPS, CAP); // as if in front of the buyer
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        vm.prank(backer);
        market.buy(address(wallet), PRICE * 2, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(alice), 195e6);
    }

    // ---- buyer protection ----

    function test_cannot_buy_twice() public {
        _pledgeAndList(wallet, alice);
        _buy(wallet, backer);
        vm.prank(backer2);
        usdg.approve(address(market), PRICE);
        vm.prank(backer2);
        vm.expectRevert(ZeroLuxMarket.NotListed.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(backer2), 1_000e6);
        assertEq(_payee(wallet), backer);

        // The owner cannot list it again either: it is no longer theirs to sell.
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotPledged.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
    }

    function test_cannot_buy_when_the_terms_are_not_the_ones_expected() public {
        _pledgeAndList(wallet, alice);
        vm.startPrank(backer);
        usdg.approve(address(market), type(uint256).max);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.buy(address(wallet), PRICE - 1, BPS, CAP, ANY, NOBASE);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.buy(address(wallet), PRICE + 1, BPS, CAP, ANY, NOBASE);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.buy(address(wallet), PRICE, BPS + 1, CAP, ANY, NOBASE);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.buy(address(wallet), PRICE, BPS, CAP - 1, ANY, NOBASE);
        vm.expectRevert(ZeroLuxMarket.NotListed.selector);
        market.buy(address(wallet2), PRICE, BPS, CAP, ANY, NOBASE);
        vm.stopPrank();
        assertEq(usdg.balanceOf(backer), 1_000e6);
    }

    function test_cannot_buy_after_the_wallet_changed_hands() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        wallet.settleLien(); // 1.2 in the escrow, earned on alice's watch
        _handTo(wallet, alice, bob);
        _earn(wallet); // 1.2 more, on bob's

        assertFalse(market.offer(address(wallet)).buyable);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.OwnerChanged.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);

        // The listing is no longer the old seller's: she can neither cancel nor collect.
        vm.startPrank(alice);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.cancel(address(wallet));
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.collect(address(wallet), alice);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.list(address(wallet), 1, BPS, CAP);
        vm.stopPrank();
        assertEq(_payee(wallet), _escrow(wallet));

        // The wallet carried its pledge and the escrow's money with it, as it does its balance.
        vm.prank(bob);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));
        assertEq(usdg.balanceOf(bob), 2.4e6);
        assertEq(usdg.balanceOf(alice), 0);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);
    }

    function test_a_new_owner_can_collect_and_list_it_as_their_own() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        wallet.settleLien();
        _handTo(wallet, alice, bob);
        vm.prank(bob);
        assertEq(market.collect(address(wallet), bob), 1.2e6);
        _earn(wallet);
        vm.prank(bob);
        market.list(address(wallet), PRICE, BPS, CAP);
        (address seller,,,,) = market.listing(address(wallet));
        assertEq(seller, bob);
        _buy(wallet, backer);
        assertEq(usdg.balanceOf(bob), 1.2e6 + 97.5e6 + 1.2e6);
        assertEq(usdg.balanceOf(alice), 0);
        assertEq(_payee(wallet), backer);
    }

    function test_a_wallet_that_goes_away_and_comes_back_to_its_seller_is_for_sale_again() public {
        _pledgeAndList(wallet, alice);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        _handTo(wallet, alice, bob);
        _earn(wallet);
        wallet.settleLien();
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.OwnerChanged.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.collect(address(wallet), alice);

        _handTo(wallet, bob, alice);
        // Alice owns it again, so her listing is hers again, and so is the escrow.
        vm.prank(bob);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.collect(address(wallet), bob);
        vm.prank(bob);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.cancel(address(wallet));
        assertTrue(market.offer(address(wallet)).buyable);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, 0);
        assertEq(usdg.balanceOf(alice), 97.5e6 + 1.2e6);
        assertEq(usdg.balanceOf(bob), 0);
        assertEq(_payee(wallet), backer);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);
    }

    function test_if_the_new_owner_listed_in_between_the_first_sellers_listing_is_gone() public {
        _pledgeAndList(wallet, alice);
        _handTo(wallet, alice, bob);
        vm.prank(bob);
        market.list(address(wallet), PRICE * 3, BPS, CAP);
        _handTo(wallet, bob, alice);
        vm.prank(backer);
        usdg.approve(address(market), type(uint256).max);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.OwnerChanged.selector); // it is bob's listing and bob no longer owns the wallet
        market.buy(address(wallet), PRICE * 3, BPS, CAP, ANY, NOBASE);
    }

    function test_cannot_buy_when_the_pledge_on_the_wallet_is_no_longer_the_one_listed() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        _earn(wallet);
        _earn(wallet); // 3.6 earned: the cap of 3 is reached
        vm.prank(alice);
        wallet.endLien(); // the owner may end a pledge that has paid its cap
        assertEq(usdg.balanceOf(_escrow(wallet)), 3e6);

        vm.prank(backer);
        usdg.approve(address(market), type(uint256).max);
        assertFalse(market.offer(address(wallet)).buyable);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.PledgeChanged.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);

        // A fresh pledge with the very same share and cap is not the one listed. All
        // that tells them apart is where they start: the first began at a profit
        // of 0, this one at the 14.4 earned since, and the listing remembers 0.
        _pledge(wallet, alice);
        assertEq(market.offer(address(wallet)).baseProfit, 0);
        assertEq(_base(wallet), 14.4e6);
        assertFalse(market.offer(address(wallet)).buyable);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.PledgeChanged.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);

        // Listed anew it sells, with a full cap ahead of it, and the seller has
        // the 3 the first pledge paid. A buyer who still expects the first
        // pledge's starting point is refused; one who accepts the new one is not.
        vm.prank(alice);
        market.list(address(wallet), PRICE, BPS, CAP);
        assertEq(market.offer(address(wallet)).baseProfit, 14.4e6);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.BaseTooHigh.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, 0, 0);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, 0, 14.4e6);
        assertEq(usdg.balanceOf(alice), 97.5e6 + 3e6);
        assertEq(_paid(wallet), 0);
        assertEq(usdg.balanceOf(address(market)), 0);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);
    }

    function test_a_pledge_the_owner_ended_at_its_cap_while_listed_pays_the_seller_on_cancel() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        _earn(wallet);
        _earn(wallet);
        usdg.setBlocked(_escrow(wallet), true); // USDG will not deliver: the wallet sets the money aside
        vm.prank(alice);
        wallet.endLien();
        assertEq(wallet.parked(_escrow(wallet)), 3e6);
        usdg.setBlocked(_escrow(wallet), false);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(wallet.parked(_escrow(wallet)), 0);
        assertEq(usdg.balanceOf(alice), 3e6);
        (,,,, bool active) = market.listing(address(wallet));
        assertFalse(active);
    }

    // ---- the guardian ----

    function test_the_guardian_pause_stops_listing_and_buying_but_not_cancel_or_collect() public {
        _pledgeAndList(wallet, alice);
        _pledge(wallet2, bob);
        _earn(wallet);
        wallet.settleLien();
        _earn(wallet);

        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotGuardian.selector);
        market.setPausedUntil(uint64(block.timestamp + 1 days));
        vm.prank(admin); // the factory's owner is not the guardian
        vm.expectRevert(ZeroLuxMarket.NotGuardian.selector);
        market.setPausedUntil(uint64(block.timestamp + 1 days));
        _pause(true);
        assertTrue(market.paused());

        vm.prank(bob);
        vm.expectRevert(ZeroLuxMarket.MarketPaused.selector);
        market.list(address(wallet2), PRICE, BPS, CAP);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.MarketPaused.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertFalse(market.offer(address(wallet)).buyable);

        vm.prank(alice);
        assertEq(market.collect(address(wallet), alice), 1.2e6);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));
        assertEq(usdg.balanceOf(alice), 2.4e6);
        vm.prank(bob);
        market.cancel(address(wallet2));
        assertEq(_payee(wallet2), address(0));

        _pause(false);
        assertFalse(market.paused());
        _pledgeAndList(wallet, alice);
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
    }

    function test_a_pause_runs_out_by_itself_and_can_never_be_set_longer_than_seven_days() public {
        _pledgeAndList(wallet, alice);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);

        vm.startPrank(guardian);
        vm.expectRevert(ZeroLuxMarket.PauseTooLong.selector);
        market.setPausedUntil(uint64(block.timestamp + 7 days + 1));
        vm.expectRevert(ZeroLuxMarket.PauseTooLong.selector);
        market.setPausedUntil(type(uint64).max);
        vm.expectEmit(true, true, true, true, address(market));
        emit PausedUntilSet(uint64(block.timestamp + 7 days));
        market.setPausedUntil(uint64(block.timestamp + 7 days));
        vm.stopPrank();
        assertEq(market.pausedUntil(), block.timestamp + 7 days);
        assertEq(market.MAX_PAUSE(), 7 days);

        // The guardian's key is lost. Nobody lifts the pause.
        skip(7 days - 1);
        assertTrue(market.paused());
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.MarketPaused.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        skip(1);
        assertFalse(market.paused());
        assertTrue(market.offer(address(wallet)).buyable);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(_payee(wallet), backer);
        _pledgeAndList(wallet2, bob); // and listing is open again
    }

    function test_the_guardian_cannot_take_move_or_freeze_anything() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        wallet.settleLien();
        PledgeEscrow e = PledgeEscrow(_escrow(wallet));

        vm.startPrank(guardian);
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.list(address(wallet), 1, BPS, CAP);
        market.setPausedUntil(uint64(block.timestamp + 7 days));
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.cancel(address(wallet));
        vm.expectRevert(ZeroLuxMarket.NotOwner.selector);
        market.collect(address(wallet), guardian);
        vm.expectRevert(PledgeEscrow.NotMarket.selector);
        e.sweep(address(usdg), guardian, true);
        vm.expectRevert(PledgeEscrow.NotMarket.selector);
        e.handOver(address(wallet), guardian);
        vm.expectRevert(PledgeEscrow.NotMarket.selector);
        e.release(address(wallet));
        vm.expectRevert(PledgeEscrow.NotMarket.selector);
        e.claimParked(address(wallet));
        vm.expectRevert(AgentWalletV3.NotOwner.selector);
        wallet.setLienPayee(guardian);
        vm.stopPrank();

        assertEq(usdg.balanceOf(guardian), 0);
        assertEq(_payee(wallet), address(e));
        assertEq(usdg.balanceOf(address(e)), 1.2e6);
        (address seller, uint128 price,,, bool active) = market.listing(address(wallet));
        assertEq(seller, alice);
        assertEq(price, PRICE);
        assertTrue(active);

        // Paused or not, the seller gets everything back.
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(usdg.balanceOf(alice), 1.2e6);
        assertEq(_payee(wallet), address(0));

        // And a buyer's pledge is out of the market's reach altogether.
        _pause(false);
        _pledgeAndList(wallet, alice);
        _buy(wallet, backer);
        _pause(true);
        _earn(wallet);
        wallet.settleLien();
        assertEq(usdg.balanceOf(backer), 901.2e6);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), backer);
    }

    function test_nobody_but_the_market_commands_an_escrow() public {
        _pledgeAndList(wallet, alice);
        PledgeEscrow e = PledgeEscrow(_escrow(wallet));
        assertEq(e.market(), address(market));
        address[4] memory who = [alice, backer, admin, operator];
        for (uint256 i; i < who.length; i++) {
            vm.startPrank(who[i]);
            vm.expectRevert(PledgeEscrow.NotMarket.selector);
            e.sweep(address(usdg), who[i], false);
            vm.expectRevert(PledgeEscrow.NotMarket.selector);
            e.handOver(address(wallet), who[i]);
            vm.expectRevert(PledgeEscrow.NotMarket.selector);
            e.release(address(wallet));
            vm.stopPrank();
        }
    }

    // ---- the fee ----

    function test_the_fee_is_exact_and_goes_to_the_factorys_treasury_of_the_moment() public {
        // A price the fee does not divide evenly: it rounds down, the seller has the rest.
        uint128 price = 33_333_333;
        _pledge(wallet, alice);
        vm.prank(alice);
        market.list(address(wallet), price, BPS, CAP);
        assertEq(market.offer(address(wallet)).fee, 833_333);

        address treasury2 = makeAddr("treasury2");
        vm.prank(admin);
        factory.proposeTreasury(treasury2);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptTreasury();

        uint256 before = usdg.balanceOf(treasury);
        vm.prank(backer);
        usdg.approve(address(market), price);
        vm.prank(backer);
        market.buy(address(wallet), price, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(treasury2), 833_333);
        assertEq(usdg.balanceOf(treasury), before);
        assertEq(usdg.balanceOf(alice), price - 833_333);
        assertEq(usdg.balanceOf(backer), 1_000e6 - price);
        assertEq(usdg.allowance(backer, address(market)), 0, "exactly the price was taken");
    }

    function test_the_fee_is_fixed_and_capped_at_five_percent() public {
        assertEq(market.feeBps(), 250);
        assertEq(market.MAX_FEE_BPS(), 500);
        vm.expectRevert(ZeroLuxMarket.FeeTooHigh.selector);
        new ZeroLuxMarket(address(factory), guardian, 501, address(0), 0, 0);
        vm.expectRevert(ZeroLuxMarket.ZeroAddress.selector);
        new ZeroLuxMarket(address(factory), address(0), 250, address(0), 0, 0);
        vm.expectRevert(ZeroLuxMarket.ZeroAddress.selector);
        new ZeroLuxMarket(address(0), guardian, 250, address(0), 0, 0);
        ZeroLuxMarket top = new ZeroLuxMarket(address(factory), guardian, 500, address(0), 0, 0);
        assertEq(top.feeBps(), 500);
        assertEq(top.usdg(), address(usdg));
        assertEq(top.guardian(), guardian);
    }

    // ---- views ----

    function test_the_offer_view_tells_a_page_everything_in_one_call() public {
        ZeroLuxMarket.Offer memory o = market.offer(address(wallet));
        assertFalse(o.active);
        assertFalse(o.buyable);
        assertEq(o.escrow, _escrow(wallet));

        _pledgeAndList(wallet, alice);
        _earn(wallet);
        o = market.offer(address(wallet));
        assertEq(o.seller, alice);
        assertEq(o.price, PRICE);
        assertEq(o.bps, BPS);
        assertEq(o.cap, CAP);
        assertEq(o.baseProfit, 0);
        assertTrue(o.active);
        assertTrue(o.buyable);
        assertEq(o.fee, 2.5e6);
        assertEq(o.paid, 0);
        assertEq(o.unpaid, 1.2e6);
        assertEq(o.customOperator, address(0));
        assertFalse(o.walletPaused);
        vm.prank(alice);
        wallet.setPaused(true);
        assertTrue(market.offer(address(wallet)).walletPaused);

        o = market.offer(makeAddr("not a wallet"));
        assertFalse(o.active);
        assertEq(o.seller, address(0));
    }

    function test_the_escrow_address_is_known_before_it_exists_and_is_one_per_wallet() public {
        address e1 = _escrow(wallet);
        address e2 = _escrow(wallet2);
        assertTrue(e1 != e2);
        assertEq(e1.code.length, 0);
        _pledgeAndList(wallet, alice);
        assertGt(e1.code.length, 0);
        assertEq(_escrow(wallet), e1);
    }

    function test_money_from_one_wallet_can_never_pay_another_wallets_seller() public {
        _pledgeAndList(wallet, alice);
        _pledgeAndList(wallet2, bob);
        _earn(wallet);
        wallet.settleLien(); // 1.2 waiting for alice

        // Bob sells, the buyer is paid 1.2 by the wallet, then points the used
        // pledge back at the escrow. Its counter says 1.2 was paid; none of it
        // was paid here, and none of alice's money moves.
        _buy(wallet2, backer);
        _earn(wallet2);
        wallet2.settleLien();
        address e2 = _escrow(wallet2);
        vm.prank(backer);
        wallet2.setLienPayee(e2);
        vm.prank(bob);
        market.cancel(address(wallet2));
        assertEq(usdg.balanceOf(bob), 97.5e6, "bob has his price and nothing of alice's");
        assertEq(usdg.balanceOf(_escrow(wallet)), 1.2e6);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(usdg.balanceOf(alice), 1.2e6);
    }

    // ---- the starting profit ----

    /// One run billed without moving the checkpoint: 4.8 of profit not yet settled.
    function _earnUnsettled(AgentWalletV3 w) internal {
        bytes32 id = keccak256(abi.encode("market-unsettled", ++runSeq));
        _payTo(w, customer, 6e6, id, 5e6);
        vm.prank(operator);
        w.charge(id, 1e6, RCPT);
    }

    function test_a_seller_cannot_remake_the_pledge_in_front_of_a_buyer_to_cut_out_unsettled_profit() public {
        _pledgeAndList(wallet, alice);
        _earnUnsettled(wallet);
        // The buyer reads the offer: starts at 0, so the 4.8 not yet settled will count for them.
        ZeroLuxMarket.Offer memory seen = market.offer(address(wallet));
        assertEq(seen.baseProfit, 0);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);

        // In front of the purchase the seller ends the pledge and makes it again:
        // same share, same cap, same price, but it now starts above the 4.8.
        address e = _escrow(wallet);
        vm.startPrank(alice);
        market.cancel(address(wallet));
        wallet.setLien(e, BPS, CAP);
        market.list(address(wallet), PRICE, BPS, CAP);
        vm.stopPrank();
        assertEq(market.offer(address(wallet)).baseProfit, 4.8e6);
        assertTrue(market.offer(address(wallet)).buyable);

        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.BaseTooHigh.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, seen.paid, seen.baseProfit);
        assertEq(usdg.balanceOf(backer), 1_000e6, "the buyer paid nothing");
        assertEq(_payee(wallet), e);
    }

    function test_an_honest_listing_gives_the_buyer_the_profit_that_was_unsettled_at_the_sale() public {
        _pledgeAndList(wallet, alice);
        _earnUnsettled(wallet);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, 0, 0);
        vm.prank(operator);
        wallet.settle(type(uint256).max);
        wallet.settleLien();
        assertEq(usdg.balanceOf(backer), 900e6 + 1.2e6);
    }

    // ---- a wallet with its own meter ----

    function test_a_wallet_with_its_own_meter_cannot_be_listed() public {
        vm.prank(alice);
        wallet.setOperator(mallory);
        _pledge(wallet, alice);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.CustomOperator.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
        assertEq(market.offer(address(wallet)).customOperator, mallory);

        // The way out is still there, and without the meter it lists.
        vm.prank(alice);
        market.cancel(address(wallet));
        vm.prank(alice);
        wallet.setOperator(address(0));
        _pledgeAndList(wallet, alice);
        assertTrue(market.offer(address(wallet)).buyable);
    }

    function test_a_wallet_with_its_own_meter_cannot_be_sold() public {
        _pledgeAndList(wallet, alice);
        // The wallet lets nobody name a meter under a pledge without the payee's
        // yes, and the escrow never says yes.
        vm.prank(alice);
        vm.expectRevert(AgentWalletV3.LienExists.selector);
        wallet.setOperator(mallory);
        // So the purchase check can only be reached by writing the wallet's storage.
        stdstore.target(address(wallet)).sig("customOperator()").checked_write(mallory);
        assertEq(wallet.customOperator(), mallory);
        assertFalse(market.offer(address(wallet)).buyable);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.CustomOperator.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
    }

    // ---- when USDG will not deliver ----

    function test_a_blocked_treasury_never_stops_a_purchase_and_the_fee_goes_to_the_seller() public {
        _pledgeAndList(wallet, alice);
        usdg.setBlocked(treasury, true);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.expectEmit(true, true, true, true, address(market));
        emit FeeRedirected(address(wallet), treasury, alice, 2.5e6);
        vm.expectEmit(true, true, true, true, address(market));
        emit Sold(address(wallet), alice, backer, PRICE, 0, BPS, CAP, 0);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(alice), 100e6, "the seller has the whole price");
        assertEq(usdg.balanceOf(backer), 900e6, "the buyer paid the price and no more");
        assertEq(usdg.allowance(backer, address(market)), 0);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(address(market)), 0);
        assertEq(_payee(wallet), backer);
    }

    function test_a_blocked_seller_cannot_sell_but_the_pledge_is_never_stuck() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        wallet.settleLien(); // 1.2 waiting in the escrow
        usdg.setBlocked(alice, true);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        vm.expectRevert(PledgeEscrow.TransferFailed.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(backer), 1_000e6);
        assertEq(_payee(wallet), _escrow(wallet));

        // With nothing waiting in the escrow it is the price that cannot be delivered.
        vm.prank(alice);
        market.collect(address(wallet), carol);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.TransferFailed.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(backer), 1_000e6);

        // She can still take the pledge off the wallet.
        _earn(wallet);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));
        assertEq(usdg.balanceOf(_escrow(wallet)), 1.2e6);
        vm.prank(alice);
        market.collect(address(wallet), carol);
        assertEq(usdg.balanceOf(carol), 2.4e6);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);
    }

    function test_a_blocked_escrow_stops_a_sale_only_while_the_seller_is_owed_through_it() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet); // 1.2 the wallet owes the pledge
        address e = _escrow(wallet);
        usdg.setBlocked(e, true);
        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        vm.expectRevert(AgentWalletV3.TransferFailed.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(backer), 1_000e6);
        assertEq(_payee(wallet), e);

        // The seller is not stuck: cancel ends the pledge, the share stays in the wallet.
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));
        assertEq(wallet.withdrawable(), _bal(wallet));
        vm.revertToState(snap);

        // Unblocked, the sale goes through and the seller has the earlier share.
        usdg.setBlocked(e, false);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(alice), 97.5e6 + 1.2e6);

        // With nothing owed through the escrow a block on it does not matter.
        _pledgeAndList(wallet2, bob);
        usdg.setBlocked(_escrow(wallet2), true);
        _buy(wallet2, backer2);
        assertEq(_payee(wallet2), backer2);
        assertEq(usdg.balanceOf(bob), 97.5e6);
    }

    function test_money_stuck_in_a_blocked_escrow_waits_for_the_owner() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        wallet.settleLien();
        address e = _escrow(wallet);
        usdg.setBlocked(e, true);
        vm.prank(alice);
        vm.expectRevert(PledgeEscrow.TransferFailed.selector);
        market.collect(address(wallet), alice);
        vm.prank(alice);
        market.cancel(address(wallet)); // the pledge goes, the money waits
        assertEq(_payee(wallet), address(0));
        assertEq(usdg.balanceOf(e), 1.2e6);
        usdg.setBlocked(e, false);
        vm.prank(alice);
        assertEq(market.collect(address(wallet), alice), 1.2e6);
    }

    // ---- cancel when the pledge is not the escrow's ----

    function test_cancel_leaves_alone_a_pledge_that_is_not_the_escrows() public {
        // No pledge at all: nothing to do, nothing breaks.
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));

        // A pledge to someone else, made outside the market.
        vm.prank(alice);
        wallet.setLien(lender, BPS, CAP);
        _earn(wallet);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), lender);
        assertEq(wallet.lienUnpaid(), 1.2e6);
        assertEq(usdg.balanceOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.NotPledged.selector);
        market.list(address(wallet), PRICE, BPS, CAP);

        // A pledge that was sold: the seller's cancel does not touch the buyer's.
        _pledgeAndList(wallet2, bob);
        _buy(wallet2, backer);
        _earn(wallet2);
        vm.prank(bob);
        market.cancel(address(wallet2));
        assertEq(_payee(wallet2), backer);
        assertEq(wallet2.lienUnpaid(), 1.2e6);
        assertEq(usdg.balanceOf(bob), 97.5e6);
    }

    // ---- how much of the cap is left ----

    function test_a_pledge_that_already_paid_its_cap_sells_only_to_a_buyer_who_says_so() public {
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        _earn(wallet);
        _earn(wallet); // 3.6 earned against a cap of 3: there is nothing left to buy
        ZeroLuxMarket.Offer memory o = market.offer(address(wallet));
        assertEq(uint256(o.paid) + o.unpaid, CAP, "a page can see the cap is used up");
        assertTrue(o.buyable);

        vm.startPrank(backer);
        usdg.approve(address(market), PRICE);
        vm.expectRevert(ZeroLuxMarket.PaidTooHigh.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, 0, NOBASE);
        vm.expectRevert(ZeroLuxMarket.PaidTooHigh.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, CAP - 1, NOBASE);
        vm.stopPrank();
        assertEq(usdg.balanceOf(backer), 1_000e6);
        assertEq(_payee(wallet), _escrow(wallet));
        assertEq(wallet.lienUnpaid(), 3e6, "the refused purchase paid nothing out");

        // Listing it again does not help the seller: the pledge still says what it paid.
        wallet.settleLien();
        vm.prank(alice);
        market.list(address(wallet), PRICE, BPS, CAP);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.PaidTooHigh.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, 0, NOBASE);
    }

    function test_a_pledge_with_no_cap_still_honours_the_buyers_limit_on_what_was_paid() public {
        address e = _escrow(wallet);
        vm.prank(alice);
        wallet.setLien(e, BPS, 0);
        vm.prank(alice);
        market.list(address(wallet), PRICE, BPS, 0);
        _earn(wallet);
        vm.startPrank(backer);
        usdg.approve(address(market), PRICE);
        vm.expectRevert(ZeroLuxMarket.PaidTooHigh.selector);
        market.buy(address(wallet), PRICE, BPS, 0, 0, NOBASE);
        market.buy(address(wallet), PRICE, BPS, 0, 1.2e6, NOBASE);
        vm.stopPrank();
        assertEq(usdg.balanceOf(alice), 97.5e6 + 1.2e6);

        // No cap: it keeps paying the buyer for as long as the agent earns.
        for (uint256 i; i < 8; i++) {
            _earn(wallet);
        }
        wallet.settleLien();
        assertEq(usdg.balanceOf(backer), 900e6 + 8 * 1.2e6);
        vm.prank(alice);
        vm.expectRevert(AgentWalletV3.LienStands.selector);
        wallet.endLien();
    }

    // ---- fuzz ----

    function testFuzz_a_sale_pays_exactly_price_less_fee_and_fee(uint128 price, uint16 bps, uint128 cap, uint16 fee)
        public
    {
        price = uint128(bound(price, 1, 1e30));
        bps = uint16(bound(bps, 1, 10_000));
        fee = uint16(bound(fee, 0, 500));
        ZeroLuxMarket m = new ZeroLuxMarket(address(factory), guardian, fee, address(0), 0, 0);
        address e = m.escrowOf(address(wallet));
        vm.prank(alice);
        wallet.setLien(e, bps, cap);
        vm.prank(alice);
        m.list(address(wallet), price, bps, cap);

        address buyer = makeAddr("fuzz-buyer");
        usdg.mint(buyer, price);
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        vm.prank(buyer);
        usdg.approve(address(m), price);
        vm.prank(buyer);
        m.buy(address(wallet), price, bps, cap, 0, NOBASE);

        uint256 cut = (uint256(price) * fee) / 10_000;
        assertEq(usdg.balanceOf(alice), price - cut);
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, cut);
        assertEq(usdg.balanceOf(buyer), 0);
        assertEq(usdg.balanceOf(address(m)), 0);
        assertEq(usdg.balanceOf(e), 0);
        assertLe(cut, uint256(price) / 20, "never more than five percent");
        (address payee, uint16 lbps, uint128 lcap, uint128 paid,) = wallet.lien();
        assertEq(payee, buyer);
        assertEq(lbps, bps);
        assertEq(lcap, cap);
        assertEq(paid, 0);
    }

    function testFuzz_any_difference_in_terms_stops_the_purchase(uint128 price, uint16 bps, uint128 cap) public {
        vm.assume(price != PRICE || bps != BPS || cap != CAP);
        _pledgeAndList(wallet, alice);
        usdg.mint(backer, type(uint128).max);
        vm.prank(backer);
        usdg.approve(address(market), type(uint256).max);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.TermsMismatch.selector);
        market.buy(address(wallet), price, bps, cap, ANY, NOBASE);
    }

    function testFuzz_what_was_earned_before_the_sale_is_the_sellers_and_after_it_the_buyers(
        uint8 runsBefore,
        uint8 runsAfter,
        uint16 bps,
        uint128 cap,
        bool settledEarly
    ) public {
        runsBefore = uint8(bound(runsBefore, 0, 6));
        runsAfter = uint8(bound(runsAfter, 0, 6));
        bps = uint16(bound(bps, 1, 10_000));
        cap = uint128(bound(cap, 0, 40e6));
        address e = _escrow(wallet);
        vm.prank(alice);
        wallet.setLien(e, bps, cap);
        vm.prank(alice);
        market.list(address(wallet), PRICE, bps, cap);

        for (uint256 i; i < runsBefore; i++) {
            _earn(wallet);
        }
        if (settledEarly) wallet.settleLien();
        uint256 before = (uint256(runsBefore) * 4.8e6 * bps) / 10_000;
        if (cap != 0 && before > cap) before = cap;

        vm.prank(backer);
        usdg.approve(address(market), PRICE);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, bps, cap, ANY, NOBASE);
        assertEq(usdg.balanceOf(alice), 97.5e6 + before, "seller: price less fee, and the earlier share");
        assertEq(usdg.balanceOf(backer), 900e6);
        assertEq(usdg.balanceOf(address(market)), 0);
        assertEq(usdg.balanceOf(_escrow(wallet)), 0);

        for (uint256 i; i < runsAfter; i++) {
            _earn(wallet);
        }
        wallet.settleLien();
        uint256 all = (uint256(runsBefore + runsAfter) * 4.8e6 * bps) / 10_000;
        if (cap != 0 && all > cap) all = cap;
        assertEq(usdg.balanceOf(backer), 900e6 + all - before, "buyer: only what came after, within the cap");
        assertEq(usdg.balanceOf(alice), 97.5e6 + before);
    }
}

/// Not a wallet of the factory, but it answers like one and says the market's
/// escrow is its payee.
contract FakeWallet {
    address public owner;
    ZeroLuxMarket internal market;

    constructor(address owner_, ZeroLuxMarket market_) {
        owner = owner_;
        market = market_;
    }

    function lien() external view returns (address, uint16, uint128, uint128, uint256) {
        return (market.escrowOf(address(this)), 2_500, 3e6, 1_000e6, 0);
    }

    function lienUnpaid() external pure returns (uint256) {
        return 1_000e6;
    }

    function parked(address) external pure returns (uint256) {
        return 1_000e6;
    }

    function settleLien() external pure returns (uint256) {
        return 0;
    }

    function endLien() external {}
    function setLienPayee(address) external {}
    function claimParked(address) external {}
}

/// A USDG that can be told to misbehave: to answer false instead of moving
/// money, or to call somewhere else in the middle of a transferFrom.
contract TrickUSDG {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public failTransferFrom;
    bool public failTransfer;
    address public failTo; // transferFrom to this address answers false
    bool public lie; // ...after moving the money all the same
    address public hookOnTo; // the hook waits for a transferFrom to this address; zero = the first one
    address public hookTarget;
    bytes public hookData;
    bool public hookRan;
    bool public hookOk;
    bytes public hookResult;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFail(bool transferFrom_, bool transfer_) external {
        failTransferFrom = transferFrom_;
        failTransfer = transfer_;
    }

    function setFailTo(address to, bool lie_) external {
        failTo = to;
        lie = lie_;
    }

    function arm(address target, bytes calldata data) external {
        armOn(address(0), target, data);
    }

    function armOn(address onTo, address target, bytes calldata data) public {
        hookOnTo = onTo;
        hookTarget = target;
        hookData = data;
        hookRan = false;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfer) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransferFrom) return false;
        address target = hookTarget;
        if (target != address(0) && (hookOnTo == address(0) || hookOnTo == to)) {
            hookTarget = address(0);
            hookRan = true;
            (hookOk, hookResult) = target.call(hookData);
        }
        if (to == failTo && !lie) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return to != failTo;
    }
}

/// A buyer that, called back in the middle of its own purchase, tries to buy again.
contract GreedyBuyer {
    ZeroLuxMarket internal market;
    TrickUSDG internal token;
    address internal wallet;
    bool public againRan;
    bool public againOk;
    bytes public againResult;

    constructor(ZeroLuxMarket market_, TrickUSDG token_, address wallet_) {
        market = market_;
        token = token_;
        wallet = wallet_;
        token_.approve(address(market_), type(uint256).max);
    }

    function attack(uint128 price, uint16 bps, uint128 cap) external {
        token.arm(address(this), abi.encodeCall(this.again, (price, bps, cap)));
        market.buy(wallet, price, bps, cap, type(uint128).max, type(uint256).max);
    }

    function again(uint128 price, uint16 bps, uint128 cap) external {
        againRan = true;
        (againOk, againResult) =
            address(market).call(abi.encodeCall(market.buy, (wallet, price, bps, cap, type(uint128).max, type(uint256).max)));
    }
}

contract MarketTokenTest is Test {
    TrickUSDG usdg;
    ZeroLuxFactoryV3 factory;
    ZeroLuxMarket market;
    AgentWalletV3 wallet;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address backer = makeAddr("backer");

    uint16 constant BPS = 2_500;
    uint128 constant CAP = 3e6;
    uint128 constant PRICE = 100e6;
    uint128 constant ANY = type(uint128).max;
    uint256 constant NOBASE = type(uint256).max;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new TrickUSDG();
        factory = new ZeroLuxFactoryV3(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        market = new ZeroLuxMarket(address(factory), guardian, 250, address(0), 0, 0);
        (, address w) = factory.createAgent(alice, 10e6, 50e6, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWalletV3(w);
        address e = market.escrowOf(w);
        vm.prank(alice);
        wallet.setLien(e, BPS, CAP);
        vm.prank(alice);
        market.list(w, PRICE, BPS, CAP);
        usdg.mint(backer, 1_000e6);
        vm.prank(backer);
        usdg.approve(address(market), type(uint256).max);
    }

    function _payee() internal view returns (address payee) {
        (payee,,,,) = wallet.lien();
    }

    function test_a_token_that_answers_false_to_transferFrom_fails_the_purchase() public {
        usdg.setFail(true, false);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.TransferFailed.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(_payee(), market.escrowOf(address(wallet)), "the pledge did not move");
        (,,,, bool active) = market.listing(address(wallet));
        assertTrue(active);

        usdg.setFail(false, false);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(_payee(), backer);
        assertEq(usdg.balanceOf(alice), 97.5e6);
        assertEq(usdg.balanceOf(treasury), 2.5e6);
    }

    function test_a_token_that_answers_false_to_transfer_fails_the_purchase_and_the_collect_but_not_the_cancel()
        public
    {
        address e = market.escrowOf(address(wallet));
        usdg.mint(e, 5e6); // money waiting for the seller
        usdg.setFail(false, true);
        vm.prank(backer);
        vm.expectRevert(PledgeEscrow.TransferFailed.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(_payee(), e);
        vm.prank(alice);
        vm.expectRevert(PledgeEscrow.TransferFailed.selector);
        market.collect(address(wallet), alice);

        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(), address(0), "the agent is free of the pledge");
        assertEq(usdg.balanceOf(e), 5e6, "the money was not lost");
        usdg.setFail(false, false);
        vm.prank(alice);
        market.collect(address(wallet), alice);
        assertEq(usdg.balanceOf(alice), 5e6);
    }

    function test_a_treasury_the_token_refuses_does_not_stop_the_purchase() public {
        usdg.setFailTo(treasury, false);
        vm.prank(backer);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(_payee(), backer);
        assertEq(usdg.balanceOf(alice), 100e6, "the fee went to the seller");
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(backer), 900e6, "the buyer paid the price and no more");
        assertEq(usdg.balanceOf(address(market)), 0);
    }

    function test_a_fee_transfer_that_moves_money_and_says_it_failed_cannot_charge_the_buyer_twice() public {
        usdg.setFailTo(treasury, true);
        vm.prank(backer);
        vm.expectRevert(ZeroLuxMarket.TransferFailed.selector);
        market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(backer), 1_000e6);
        assertEq(usdg.balanceOf(alice), 0);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(_payee(), market.escrowOf(address(wallet)));
    }

    function test_a_failing_fee_transfer_cannot_be_used_to_get_back_into_the_market() public {
        bytes[4] memory calls = [
            abi.encodeCall(market.buy, (address(wallet), PRICE, BPS, CAP, ANY, NOBASE)),
            abi.encodeCall(market.cancel, (address(wallet))),
            abi.encodeCall(market.collect, (address(wallet), treasury)),
            abi.encodeCall(market.list, (address(wallet), 1, BPS, CAP))
        ];
        for (uint256 i; i < calls.length; i++) {
            uint256 snap = vm.snapshotState();
            usdg.setFailTo(treasury, false);
            usdg.armOn(treasury, address(market), calls[i]); // called back in the fee leg, which then fails
            vm.prank(backer);
            market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
            assertTrue(usdg.hookRan());
            assertFalse(usdg.hookOk());
            assertEq(bytes4(usdg.hookResult()), ZeroLuxMarket.Reentrancy.selector);
            assertEq(_payee(), backer);
            assertEq(usdg.balanceOf(alice), 100e6);
            assertEq(usdg.balanceOf(treasury), 0);
            assertEq(usdg.balanceOf(backer), 900e6, "the price and no more");
            assertEq(usdg.balanceOf(address(market)), 0);
            vm.revertToState(snap);
        }
    }

    function test_a_token_that_calls_back_into_the_market_mid_purchase_is_refused() public {
        bytes[4] memory calls = [
            abi.encodeCall(market.buy, (address(wallet), PRICE, BPS, CAP, ANY, type(uint256).max)),
            abi.encodeCall(market.cancel, (address(wallet))),
            abi.encodeCall(market.collect, (address(wallet), address(usdg))),
            abi.encodeCall(market.list, (address(wallet), 1, BPS, CAP))
        ];
        for (uint256 i; i < calls.length; i++) {
            uint256 snap = vm.snapshotState();
            usdg.arm(address(market), calls[i]);
            vm.prank(backer);
            market.buy(address(wallet), PRICE, BPS, CAP, ANY, NOBASE);
            assertTrue(usdg.hookRan(), "the token did call back");
            assertFalse(usdg.hookOk(), "and was refused");
            assertEq(bytes4(usdg.hookResult()), ZeroLuxMarket.Reentrancy.selector);
            assertEq(_payee(), backer);
            assertEq(usdg.balanceOf(alice), 97.5e6);
            assertEq(usdg.balanceOf(treasury), 2.5e6);
            assertEq(usdg.balanceOf(backer), 900e6);
            assertEq(usdg.balanceOf(address(market)), 0);
            vm.revertToState(snap);
        }
    }

    function test_a_buyer_that_tries_to_buy_again_inside_its_own_purchase_pays_once_and_gets_one_pledge() public {
        GreedyBuyer greedy = new GreedyBuyer(market, usdg, address(wallet));
        usdg.mint(address(greedy), 500e6);
        greedy.attack(PRICE, BPS, CAP);
        assertTrue(greedy.againRan());
        assertFalse(greedy.againOk());
        assertEq(bytes4(greedy.againResult()), ZeroLuxMarket.Reentrancy.selector);
        assertEq(usdg.balanceOf(address(greedy)), 400e6, "paid once");
        assertEq(usdg.balanceOf(alice), 97.5e6);
        assertEq(usdg.balanceOf(treasury), 2.5e6);
        assertEq(_payee(), address(greedy));

        // Afterwards, in a call of its own, there is nothing left to buy.
        greedy.again(PRICE, BPS, CAP);
        assertFalse(greedy.againOk());
        assertEq(bytes4(greedy.againResult()), ZeroLuxMarket.NotListed.selector);
    }
}

/// A locker that says whatever the test tells it to, for the cases the real
/// one cannot be brought to: a lock that got shorter, and a locker that fails.
contract FakeLocker {
    uint64 public constant MAX_LOCK = 730 days;
    mapping(address => uint256) amountOf;
    mapping(address => uint64) unlockOf;
    bool public broken;

    function set(address who, uint256 amount, uint64 unlockAt) external {
        amountOf[who] = amount;
        unlockOf[who] = unlockAt;
    }

    function setBroken(bool on) external {
        broken = on;
    }

    function locked(address who) external view returns (uint256, uint64) {
        require(!broken, "locker is down");
        return (amountOf[who], unlockOf[who]);
    }

    function lockedOf(address who) external view returns (uint256) {
        require(!broken, "locker is down");
        return block.timestamp < unlockOf[who] ? amountOf[who] : 0;
    }
}

/// The market with a bond asked of sellers: 1,000 $LUX locked for 90 days past
/// the listing, read from the real locker.
contract MarketBondTest is MarketBase {
    MockLux lux;
    LuxLocker locker;

    uint256 constant BOND = 1_000e18;
    uint32 constant BOND_DAYS = 90;
    uint64 constant DAY = 1 days;

    function setUp() public override {
        super.setUp();
        lux = new MockLux();
        locker = new LuxLocker(address(lux));
        // Every helper of the base now speaks to the market that asks a bond.
        market = new ZeroLuxMarket(address(factory), guardian, FEE, address(locker), BOND, BOND_DAYS);
        _fundLux(alice);
        _fundLux(bob);
    }

    function _fundLux(address who) internal {
        lux.mint(who, 10_000e18);
        vm.prank(who);
        lux.approve(address(locker), type(uint256).max);
    }

    function _now() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    function _lockLux(address who, uint256 amount, uint64 unlockAt) internal {
        vm.prank(who);
        locker.lock(amount, unlockAt);
    }

    function _tryBuy(AgentWalletV3 w, address who, bytes4 err) internal {
        vm.prank(who);
        usdg.approve(address(market), PRICE);
        uint256 before = usdg.balanceOf(who);
        vm.prank(who);
        vm.expectRevert(err);
        market.buy(address(w), PRICE, BPS, CAP, ANY, NOBASE);
        assertEq(usdg.balanceOf(who), before, "the buyer paid nothing");
        assertEq(_payee(w), _escrow(w), "and the pledge did not move");
    }

    // ---- construction ----

    function test_the_bond_is_fixed_at_construction() public {
        assertEq(market.locker(), address(locker));
        assertEq(market.bond(), BOND);
        assertEq(market.bondDays(), BOND_DAYS);
        assertTrue(market.bondOn());

        vm.expectRevert(ZeroLuxMarket.LockerNotAContract.selector);
        new ZeroLuxMarket(address(factory), guardian, FEE, makeAddr("no locker here"), BOND, BOND_DAYS);
        // A bond longer than any lock can run could never be met.
        vm.expectRevert(ZeroLuxMarket.BondDaysTooLong.selector);
        new ZeroLuxMarket(address(factory), guardian, FEE, address(locker), BOND, 731);
        ZeroLuxMarket longest = new ZeroLuxMarket(address(factory), guardian, FEE, address(locker), BOND, 730);
        assertEq(longest.bondDays(), 730);
        // The earlier checks still stand with the new arguments in place.
        vm.expectRevert(ZeroLuxMarket.FeeTooHigh.selector);
        new ZeroLuxMarket(address(factory), guardian, 501, address(locker), BOND, BOND_DAYS);
        vm.expectRevert(ZeroLuxMarket.ZeroAddress.selector);
        new ZeroLuxMarket(address(factory), address(0), FEE, address(locker), BOND, BOND_DAYS);
    }

    // ---- list ----

    function test_cannot_list_without_the_bond() public {
        _pledge(wallet, alice);
        assertFalse(market.bondReady(alice));
        assertFalse(market.offer(address(wallet)).bondMet);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.BondMissing.selector);
        market.list(address(wallet), PRICE, BPS, CAP);

        // One unit short is still short.
        _lockLux(alice, BOND - 1, _now() + 365 * DAY);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.BondMissing.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
        (,,,, bool active) = market.listing(address(wallet));
        assertFalse(active);

        // Somebody else's lock is not the seller's.
        _lockLux(bob, BOND, _now() + 365 * DAY);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.BondMissing.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
    }

    function test_cannot_list_with_a_lock_that_ends_too_soon() public {
        _pledge(wallet, alice);
        _lockLux(alice, BOND, _now() + BOND_DAYS * DAY - 1);
        assertFalse(market.bondReady(alice));
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.BondTooShort.selector);
        market.list(address(wallet), PRICE, BPS, CAP);

        // A lock that was long enough when made, and is not any more.
        vm.prank(alice);
        locker.extend(_now() + BOND_DAYS * DAY);
        assertTrue(market.bondReady(alice));
        vm.warp(block.timestamp + 1);
        assertFalse(market.bondReady(alice));
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.BondTooShort.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
    }

    function test_can_list_and_sell_with_the_bond_and_the_bond_is_never_touched() public {
        _lockLux(alice, BOND, _now() + BOND_DAYS * DAY); // to the very second
        assertTrue(market.bondReady(alice));
        _pledge(wallet, alice);
        assertTrue(market.offer(address(wallet)).bondMet, "not listed: the owner could list now");
        assertEq(market.offer(address(wallet)).bondUntil, 0);
        vm.prank(alice);
        market.list(address(wallet), PRICE, BPS, CAP);

        ZeroLuxMarket.Offer memory o = market.offer(address(wallet));
        assertTrue(o.active);
        assertTrue(o.bondMet);
        assertTrue(o.buyable);
        assertEq(o.bondUntil, _now() + BOND_DAYS * DAY);
        assertEq(o.seller, alice);

        uint256 treasuryBefore = usdg.balanceOf(treasury);
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
        assertEq(usdg.balanceOf(alice), 97.5e6, "the price less the fee, as without a bond");
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, 2.5e6);
        assertEq(usdg.balanceOf(backer), 900e6);

        (uint256 amount, uint64 unlockAt) = locker.locked(alice);
        assertEq(amount, BOND, "the bond is still the seller's, where it was");
        assertEq(unlockAt, _now() + BOND_DAYS * DAY);
        assertEq(lux.balanceOf(address(locker)), BOND);
        assertEq(lux.balanceOf(address(market)), 0);
    }

    function test_one_lock_serves_every_pledge_its_holder_lists() public {
        _lockLux(alice, BOND, _now() + 365 * DAY);
        _pledgeAndList(wallet, alice);
        _pledgeAndList(wallet3, alice); // alice owns this one too
        assertTrue(market.offer(address(wallet)).buyable);
        assertTrue(market.offer(address(wallet3)).buyable);
        // And bob, who has locked nothing, still cannot list his.
        _pledge(wallet2, bob);
        vm.prank(bob);
        vm.expectRevert(ZeroLuxMarket.BondMissing.selector);
        market.list(address(wallet2), PRICE, BPS, CAP);
    }

    function test_listing_again_counts_the_bond_days_from_now() public {
        _lockLux(alice, BOND, _now() + BOND_DAYS * DAY);
        _pledgeAndList(wallet, alice);
        uint64 first = market.offer(address(wallet)).bondUntil;
        vm.warp(block.timestamp + 30 * DAY);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxMarket.BondTooShort.selector);
        market.list(address(wallet), PRICE / 2, BPS, CAP);
        // The refused change left the listing as it was.
        assertEq(market.offer(address(wallet)).bondUntil, first);
        assertEq(market.offer(address(wallet)).price, PRICE);

        vm.prank(alice);
        locker.extend(_now() + BOND_DAYS * DAY);
        vm.prank(alice);
        market.list(address(wallet), PRICE / 2, BPS, CAP);
        assertEq(market.offer(address(wallet)).bondUntil, first + 30 * DAY);
        assertEq(market.offer(address(wallet)).price, PRICE / 2);
    }

    // ---- buy ----

    function test_time_passing_alone_does_not_undo_a_listing_whose_lock_still_covers_its_time() public {
        // The time is fixed when the pledge is listed: listing time plus the bond days.
        _lockLux(alice, BOND, _now() + BOND_DAYS * DAY);
        _pledgeAndList(wallet, alice);
        vm.warp(block.timestamp + 60 * DAY);
        assertFalse(market.bondReady(alice), "she could not list afresh today");
        assertTrue(market.offer(address(wallet)).bondMet, "but the listing she made stands");
        assertTrue(market.offer(address(wallet)).buyable);
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
    }

    function test_buy_reverts_once_the_lock_is_over_even_if_the_bond_was_never_taken_out() public {
        uint64 until = _now() + BOND_DAYS * DAY;
        _lockLux(alice, BOND, until);
        _pledgeAndList(wallet, alice);

        // One second before the lock ends the pledge can still be bought.
        vm.warp(until - 1);
        assertTrue(market.offer(address(wallet)).bondMet);
        assertTrue(market.offer(address(wallet)).buyable);
        uint256 snap = vm.snapshotState();
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
        vm.revertToState(snap);

        // The lock ends. The tokens are still in the locker, and free to leave.
        vm.warp(until);
        (uint256 amount, uint64 unlockAt) = locker.locked(alice);
        assertEq(amount, BOND, "not withdrawn");
        assertEq(unlockAt, market.offer(address(wallet)).bondUntil, "and it ran to the listing's time");
        assertEq(locker.lockedOf(alice), 0);

        ZeroLuxMarket.Offer memory o = market.offer(address(wallet));
        assertTrue(o.active, "still listed");
        assertFalse(o.bondMet, "the page says what buy will say");
        assertFalse(o.buyable);
        _tryBuy(wallet, backer, ZeroLuxMarket.BondMissing.selector);

        vm.warp(until + 200 * DAY);
        assertFalse(market.offer(address(wallet)).buyable);
        _tryBuy(wallet, backer, ZeroLuxMarket.BondMissing.selector);
    }

    function test_a_seller_who_extended_the_lock_can_still_be_bought_from() public {
        uint64 until = _now() + BOND_DAYS * DAY;
        _lockLux(alice, BOND, until);
        _pledgeAndList(wallet, alice);

        // Extended before it ended: the listing never stops being for sale.
        vm.warp(until - 1 * DAY);
        vm.prank(alice);
        locker.extend(until + 30 * DAY);
        vm.warp(until + 10 * DAY);
        assertTrue(market.offer(address(wallet)).bondMet);
        assertTrue(market.offer(address(wallet)).buyable);
        uint256 snap = vm.snapshotState();
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
        assertEq(usdg.balanceOf(alice), 97.5e6);
        vm.revertToState(snap);

        // Left to run out, then extended: the same listing is for sale again.
        vm.warp(until + 30 * DAY);
        assertFalse(market.offer(address(wallet)).buyable);
        _tryBuy(wallet, backer, ZeroLuxMarket.BondMissing.selector);
        vm.prank(alice);
        locker.extend(_now() + 7 * DAY);
        assertTrue(market.offer(address(wallet)).bondMet);
        assertTrue(market.offer(address(wallet)).buyable);
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
        assertEq(locker.lockedOf(alice), BOND, "the bond is still the seller's, and still locked");
    }

    function test_buy_reverts_once_the_seller_has_taken_the_bond_out() public {
        _lockLux(alice, BOND, _now() + BOND_DAYS * DAY);
        _pledgeAndList(wallet, alice);
        vm.warp(block.timestamp + BOND_DAYS * DAY); // the lock is over
        vm.prank(alice);
        locker.withdraw();

        ZeroLuxMarket.Offer memory o = market.offer(address(wallet));
        assertTrue(o.active, "still listed");
        assertFalse(o.bondMet);
        assertFalse(o.buyable);
        _tryBuy(wallet, backer, ZeroLuxMarket.BondMissing.selector);

        // A fresh position that is too small does not bring the listing back.
        _lockLux(alice, BOND - 1, _now() + 7 * DAY);
        assertFalse(market.offer(address(wallet)).buyable);
        _tryBuy(wallet, backer, ZeroLuxMarket.BondMissing.selector);

        // Topped up to the bond it does: the lock again runs past the listing's time.
        _lockLux(alice, 1, _now() + 7 * DAY);
        assertTrue(market.offer(address(wallet)).bondMet);
        assertTrue(market.offer(address(wallet)).buyable);
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
    }

    function test_buy_reverts_if_the_sellers_lock_no_longer_runs_to_the_listings_time() public {
        // The real locker never lets a lock get shorter, so this uses one that does.
        FakeLocker fake = new FakeLocker();
        market = new ZeroLuxMarket(address(factory), guardian, FEE, address(fake), BOND, BOND_DAYS);
        uint64 until = _now() + BOND_DAYS * DAY;
        fake.set(alice, BOND, until);
        _pledgeAndList(wallet, alice);
        assertEq(market.offer(address(wallet)).bondUntil, until);

        fake.set(alice, BOND, until - 1);
        assertFalse(market.offer(address(wallet)).bondMet);
        assertFalse(market.offer(address(wallet)).buyable);
        _tryBuy(wallet, backer, ZeroLuxMarket.BondTooShort.selector);

        fake.set(alice, BOND - 1, until + 365 * DAY);
        _tryBuy(wallet, backer, ZeroLuxMarket.BondMissing.selector);

        // Measured from the listing, not from now: much later the same lock still serves.
        fake.set(alice, BOND, until);
        vm.warp(block.timestamp + 80 * DAY);
        assertTrue(market.offer(address(wallet)).buyable);
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
    }

    function test_a_buyer_cannot_use_their_own_lock_in_place_of_the_sellers() public {
        _lockLux(alice, BOND, _now() + BOND_DAYS * DAY);
        _pledgeAndList(wallet, alice);
        vm.warp(block.timestamp + BOND_DAYS * DAY);
        vm.prank(alice);
        locker.withdraw();
        _fundLux(backer);
        _lockLux(backer, BOND, _now() + 365 * DAY);
        _tryBuy(wallet, backer, ZeroLuxMarket.BondMissing.selector);
    }

    function test_a_new_owner_lists_on_their_own_bond() public {
        _lockLux(alice, BOND, _now() + 365 * DAY);
        _pledgeAndList(wallet, alice);
        _handTo(wallet, alice, bob);
        assertFalse(market.offer(address(wallet)).buyable);
        _tryBuy(wallet, backer, ZeroLuxMarket.OwnerChanged.selector);
        vm.prank(bob);
        vm.expectRevert(ZeroLuxMarket.BondMissing.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
        _lockLux(bob, BOND, _now() + BOND_DAYS * DAY);
        vm.prank(bob);
        market.list(address(wallet), PRICE, BPS, CAP);
        _buy(wallet, backer);
        assertEq(usdg.balanceOf(bob), 97.5e6);
    }

    // ---- cancel and collect ask nothing ----

    function test_cancel_and_collect_work_for_an_owner_who_never_had_a_bond() public {
        _pledge(wallet, alice); // pledged to the escrow, cannot list
        _earn(wallet);
        wallet.settleLien();
        assertEq(usdg.balanceOf(_escrow(wallet)), 1.2e6);
        vm.prank(alice);
        assertEq(market.collect(address(wallet), carol), 1.2e6);
        assertEq(usdg.balanceOf(carol), 1.2e6);

        _earn(wallet);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0), "the wallet is pledged to nobody");
        assertEq(usdg.balanceOf(alice), 1.2e6);
    }

    function test_cancel_and_collect_work_after_the_bond_has_been_taken_out() public {
        _lockLux(alice, BOND, _now() + BOND_DAYS * DAY);
        _pledgeAndList(wallet, alice);
        _earn(wallet);
        wallet.settleLien();
        vm.warp(block.timestamp + BOND_DAYS * DAY);
        vm.prank(alice);
        locker.withdraw();
        assertEq(lux.balanceOf(alice), 10_000e18);

        vm.prank(alice);
        assertEq(market.collect(address(wallet), alice), 1.2e6);
        _earn(wallet);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));
        (,,,, bool active) = market.listing(address(wallet));
        assertFalse(active);
        assertEq(usdg.balanceOf(alice), 2.4e6);
    }

    function test_cancel_and_collect_work_even_if_the_locker_fails_and_while_paused() public {
        FakeLocker fake = new FakeLocker();
        market = new ZeroLuxMarket(address(factory), guardian, FEE, address(fake), BOND, BOND_DAYS);
        fake.set(alice, BOND, _now() + BOND_DAYS * DAY);
        fake.set(bob, BOND, _now() + BOND_DAYS * DAY);
        _pledgeAndList(wallet, alice);
        _pledgeAndList(wallet2, bob);
        _earn(wallet);
        wallet.settleLien();

        fake.setBroken(true);
        _pause(true);
        vm.prank(alice);
        assertEq(market.collect(address(wallet), alice), 1.2e6);
        vm.prank(alice);
        market.cancel(address(wallet));
        assertEq(_payee(wallet), address(0));
        vm.prank(bob);
        market.cancel(address(wallet2));
        assertEq(_payee(wallet2), address(0));
    }

    // ---- bond off ----

    function test_with_no_locker_or_no_bond_the_market_asks_nothing() public {
        ZeroLuxMarket[3] memory off = [
            new ZeroLuxMarket(address(factory), guardian, FEE, address(0), 0, 0),
            new ZeroLuxMarket(address(factory), guardian, FEE, address(0), BOND, BOND_DAYS),
            new ZeroLuxMarket(address(factory), guardian, FEE, address(locker), 0, BOND_DAYS)
        ];
        for (uint256 i; i < off.length; ++i) {
            uint256 snap = vm.snapshotState();
            market = off[i];
            assertFalse(market.bondOn());
            assertTrue(market.bondReady(alice));
            assertEq(locker.lockedOf(alice), 0, "alice has locked nothing");
            _pledgeAndList(wallet, alice);
            ZeroLuxMarket.Offer memory o = market.offer(address(wallet));
            assertTrue(o.bondMet);
            assertEq(o.bondUntil, 0);
            assertTrue(o.buyable);
            _buy(wallet, backer);
            assertEq(_payee(wallet), backer);
            assertEq(usdg.balanceOf(alice), 97.5e6);
            assertEq(usdg.balanceOf(backer), 900e6);
            vm.revertToState(snap);
        }
    }

    function test_a_market_with_the_bond_off_never_calls_a_locker() public {
        // The locker named has no code at all: any call to it would fail.
        market = new ZeroLuxMarket(address(factory), guardian, FEE, makeAddr("nothing here"), 0, 0);
        _pledgeAndList(wallet, alice);
        assertTrue(market.offer(address(wallet)).buyable);
        _buy(wallet, backer);
        assertEq(_payee(wallet), backer);
    }

    // ---- fuzz ----

    function testFuzz_listing_needs_the_amount_and_the_time(uint256 amount, uint64 dur, uint64 wait) public {
        amount = bound(amount, 1, 10_000e18);
        dur = uint64(bound(dur, 7 * DAY, 730 * DAY));
        wait = uint64(bound(wait, 0, 400 * DAY));
        uint64 unlockAt = _now() + dur;
        _lockLux(alice, amount, unlockAt);
        vm.warp(block.timestamp + wait);
        _pledge(wallet, alice);

        bool enough = amount >= BOND;
        bool longEnough = unlockAt >= block.timestamp + BOND_DAYS * DAY;
        assertEq(market.bondReady(alice), enough && longEnough);
        vm.prank(alice);
        if (!enough) vm.expectRevert(ZeroLuxMarket.BondMissing.selector);
        else if (!longEnough) vm.expectRevert(ZeroLuxMarket.BondTooShort.selector);
        market.list(address(wallet), PRICE, BPS, CAP);
        (,,,, bool active) = market.listing(address(wallet));
        assertEq(active, enough && longEnough);
        assertEq(market.offer(address(wallet)).buyable, enough && longEnough);
    }
}
