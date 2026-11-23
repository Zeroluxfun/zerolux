// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactoryV4} from "../src/ZeroLuxFactoryV4.sol";
import {AgentWalletV4} from "../src/AgentWalletV4.sol";
import {ZeroLuxFactoryV3} from "../src/ZeroLuxFactoryV3.sol";
import {AgentWalletV3} from "../src/AgentWalletV3.sol";
import {V4Base} from "./V4.t.sol";

/// What version 4 is for. On every earlier wallet the meter could set money
/// aside from the wallet's own balance (`open`) and bill it to the treasury, up
/// to the day limit, with no customer payment behind it. Each test here takes
/// one way of reaching money that was not paid in for the run and shows it
/// closed. The limits are set as high as they go throughout, so nothing here
/// rests on them.
contract V4DrainTest is V4Base {
    uint128 constant MAX = type(uint128).max;
    uint256 constant IDLE = 500e6; // the owner's earnings, sitting in the wallet

    function setUp() public override {
        super.setUp();
        usdg.mint(address(wallet), IDLE);
        vm.prank(alice);
        wallet.setLimits(MAX, MAX);
        vm.prank(bob);
        wallet2.setLimits(MAX, MAX);
    }

    function _idle(AgentWalletV4 w) internal view returns (uint256) {
        return _bal(w) - w.heldTotal() - w.parkedTotal();
    }

    function _untouched() internal view {
        assertEq(usdg.balanceOf(treasury), 0, "nothing reached the treasury");
        assertEq(_idle(wallet), IDLE, "the idle money is all there");
        assertEq(wallet.withdrawable(), IDLE, "and all the owner's");
    }

    // ---- the route that was open ----

    function test_for_contrast_the_same_calls_drain_a_version_3_wallet() public {
        ZeroLuxFactoryV3 f3 = new ZeroLuxFactoryV3(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        (, address w_) = f3.createAgent(alice, 60e6, 120e6, keccak256("spec"), "", treasury, 2_000);
        AgentWalletV3 w3 = AgentWalletV3(w_);
        usdg.mint(w_, IDLE);
        vm.startPrank(operator);
        w3.open("made-up-1", 50e6);
        w3.charge("made-up-1", 50e6, RCPT);
        w3.open("made-up-2", 50e6);
        w3.charge("made-up-2", 50e6, RCPT);
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 120e6, "a day's limit of the owner's money, for runs nobody paid for");
        assertEq(usdg.balanceOf(w_), IDLE - 120e6);
    }

    function test_open_is_gone_for_everyone() public {
        address[5] memory who = [operator, alice, guardian, admin, mallory];
        for (uint256 i; i < who.length; i++) {
            _openIsGone(wallet, who[i], bytes32(i + 1), 50e6);
            _openIsGone(wallet, who[i], bytes32(i + 1), 1);
        }
        vm.prank(alice);
        wallet.setOperator(mallory); // nor for a meter the owner names
        _openIsGone(wallet, mallory, "m", 1);
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.remainingToday(), MAX);
        _untouched();
    }

    function test_the_version_3_selectors_that_took_from_the_balance_do_not_exist() public {
        bytes[3] memory calls = [
            abi.encodeWithSignature("open(bytes32,uint256)", bytes32("r"), uint256(1)),
            abi.encodeWithSignature("charge(bytes32,uint256)", bytes32("r"), uint256(1)), // version 1 and 2 form
            abi.encodeWithSignature("chargeAndSettle(bytes32,uint256,uint256)", bytes32("r"), uint256(1), uint256(0))
        ];
        for (uint256 i; i < calls.length; i++) {
            vm.prank(operator);
            (bool ok,) = address(wallet).call(calls[i]);
            assertFalse(ok);
        }
        _untouched();
    }

    // ---- billing a run nobody paid for ----

    function test_a_run_that_was_never_paid_cannot_be_charged_refunded_or_used_to_pay_an_agent() public {
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        vm.startPrank(operator);
        vm.expectRevert(AgentWalletV4.NotOpen.selector);
        wallet.charge("made-up", 50e6, RCPT);
        vm.expectRevert(AgentWalletV4.NotOpen.selector);
        wallet.charge("made-up", 1, RCPT);
        vm.expectRevert(AgentWalletV4.NotOpen.selector);
        wallet.chargeAndSettle("made-up", 50e6, type(uint256).max, RCPT);
        vm.expectRevert(AgentWalletV4.NotOpen.selector);
        wallet.refund("made-up", 50e6, RCPT);
        vm.expectRevert(AgentWalletV4.NotOpen.selector);
        wallet.refund("made-up", 0, RCPT);
        vm.expectRevert(AgentWalletV4.NotOpen.selector);
        wallet.payAgent("made-up", address(wallet2), 50e6, "s", 1e6);
        vm.expectRevert(AgentWalletV4.NotOpen.selector);
        wallet.release("made-up");
        vm.stopPrank();
        _untouched();
        assertEq(_bal(wallet2), 0);
    }

    // ---- a payment that is not there ----

    function test_a_payment_that_moves_nothing_opens_nothing() public {
        vm.startPrank(operator);
        // A replayed authorization: USDG accepts it and moves nothing.
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 1, false);
        vm.expectRevert(AgentWalletV4.NotPaid.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r2", 1, false);
        // The wallet "paying" itself: its balance does not rise.
        vm.expectRevert(AgentWalletV4.NotPaid.selector);
        wallet.pay(address(wallet), 50e6, 0, block.timestamp + 600, "n2", 27, bytes32(0), bytes32(0), "r3", 40e6, false);
        // A payment of nothing.
        vm.expectRevert(AgentWalletV4.ZeroCost.selector);
        wallet.pay(customer, 0, 0, block.timestamp + 600, "n3", 27, bytes32(0), bytes32(0), "r4", 0, false);
        vm.expectRevert(AgentWalletV4.Underpaid.selector);
        wallet.pay(customer, 0, 0, block.timestamp + 600, "n4", 27, bytes32(0), bytes32(0), "r4", 1, false);
        vm.stopPrank();
        assertEq(wallet.heldTotal(), 1e6, "only the one real payment is held");
        assertEq(_idle(wallet), IDLE);
    }

    function test_a_small_payment_cannot_carry_a_large_budget() public {
        vm.startPrank(operator);
        // $1 paid, a budget that would reach into the idle money: refused, nothing taken.
        vm.expectRevert(AgentWalletV4.Underpaid.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 50e6, false);
        vm.expectRevert(AgentWalletV4.Underpaid.selector);
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 833_335, false); // 1.000002 with the fee
        assertEq(usdg.balanceOf(customer), 1_000e6);
        // The largest budget $1 can carry.
        wallet.pay(customer, 1e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 833_334, false);
        vm.expectRevert(AgentWalletV4.OverRunCap.selector);
        wallet.charge("r1", 833_335, RCPT);
        vm.expectRevert(AgentWalletV4.OverRunCap.selector);
        wallet.charge("r1", 50e6, RCPT);
        vm.expectRevert(AgentWalletV4.OverRunCap.selector);
        wallet.refund("r1", 50e6, RCPT);
        wallet.charge("r1", 833_334, RCPT);
        vm.expectRevert(AgentWalletV4.NotOpen.selector);
        wallet.charge("r1", 1, RCPT); // and only once
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 1e6, "all that was paid in for the run, and not a unit more");
        assertEq(_idle(wallet), IDLE, "the idle money is where it was");
    }

    function test_the_meter_paying_from_its_own_pocket_gets_back_no_more_than_it_put_in() public {
        usdg.mint(operator, 10e6);
        vm.startPrank(operator);
        wallet.pay(operator, 10e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 8e6, false);
        wallet.charge("r1", 8e6, RCPT);
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 9_600_000);
        assertEq(_idle(wallet), IDLE + 400_000, "it cost the meter 0.4 to try");
        assertEq(usdg.balanceOf(operator), 0);
    }

    // ---- through another agent ----

    function test_paying_another_agent_moves_only_the_runs_own_payment() public {
        usdg.mint(address(wallet2), IDLE);
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        _pay(6e6, "r1", 5e6);
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");

        vm.startPrank(operator);
        vm.expectRevert(AgentWalletV4.OverRunCap.selector);
        wallet.payAgent("r1", address(wallet2), 5e6 + 1, "s1", 1e6); // more than the run's budget
        vm.expectRevert(AgentWalletV4.Underpaid.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 50e6); // a sub-budget that would reach wallet2's idle money
        wallet.payAgent("r1", address(wallet2), 5e6, "s1", 4_166_666);
        vm.expectRevert(AgentWalletV4.OverRunCap.selector);
        wallet2.charge(key, 4_166_667, RCPT);
        wallet2.charge(key, 4_166_666, RCPT); // 4,999,999 with the fee
        vm.expectRevert(AgentWalletV4.OverRunCap.selector);
        wallet.charge("r1", 1, RCPT); // the paying run has no budget left
        wallet.refund("r1", 0, RCPT);
        vm.stopPrank();

        assertEq(usdg.balanceOf(treasury), 4_999_999);
        assertLe(usdg.balanceOf(treasury), 6e6, "both wallets together: no more than the one payment");
        assertEq(_idle(wallet), IDLE);
        assertEq(_idle(wallet2), IDLE + 1);
        assertEq(usdg.balanceOf(customer), 1_000e6 - 5e6, "the customer has back what the run did not pass on");
    }

    function test_the_agent_to_agent_doors_cannot_be_used_directly() public {
        usdg.mint(operator, 10e6);
        vm.startPrank(operator);
        usdg.approve(address(wallet), type(uint256).max);
        vm.expectRevert(AgentWalletV4.NotAgent.selector);
        wallet.payFromAgent(1e6, "r", 500_000, operator); // only another agent wallet may
        vm.expectRevert(AgentWalletV4.NotPaid.selector);
        wallet.returnFromAgent("r", 1e6); // nothing was ever paid out to return
        vm.expectRevert(AgentWalletV4.NothingParked.selector);
        wallet.retryReturn("r");
        vm.expectRevert(AgentWalletV4.NothingParked.selector);
        wallet.claimParked(operator);
        vm.expectRevert(AgentWalletV4.NotOwner.selector);
        wallet.withdraw(address(usdg), operator, 1);
        vm.stopPrank();
        _untouched();
    }

    // ---- through the terms ----

    function test_a_published_markup_raised_while_a_run_is_open_takes_nothing_more() public {
        _pay(6e6, "r1", 5e6); // reserved 6 at 20%
        vm.prank(admin);
        factory.proposeMarkup(5_000);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptMarkup();
        vm.prank(alice);
        wallet.adoptTerms(treasury, 5_000); // even adopted, the wallet's markup does not go up
        assertEq(wallet.markupBps(), 2_000);
        vm.startPrank(operator);
        vm.expectRevert(AgentWalletV4.OverRunCap.selector);
        wallet.charge("r1", 5e6 + 1, RCPT);
        wallet.charge("r1", 5e6, RCPT); // 6.0: all the run paid, and no more
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 6e6);
        assertEq(_idle(wallet), IDLE);
    }

    function test_the_checkpoint_gives_the_meter_no_way_to_the_idle_money() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 10e6); // income after the lien
        vm.startPrank(operator);
        wallet.settle(type(uint256).max);
        wallet.settle(0);
        vm.stopPrank();
        // Half of the new income is the lender's by the owner's own pledge; the meter gained nothing.
        assertEq(wallet.lienUnpaid(), 5e6);
        assertEq(wallet.withdrawable(), IDLE + 5e6);
        assertEq(usdg.balanceOf(treasury), 0);
        _openIsGone(wallet, operator, "x", 1);
    }

    // ---- any payment, any budget, any cost ----

    function testFuzz_the_treasury_never_gets_more_than_the_run_paid_in_and_idle_money_never_falls(
        uint256 value,
        uint256 budget,
        uint256 cost,
        uint16 markup,
        bool refund
    ) public {
        markup = uint16(bound(markup, 0, 2_000));
        vm.prank(operator);
        (, address w_) = factory.createAgent(alice, MAX, MAX, keccak256("spec"), "", treasury, markup);
        AgentWalletV4 w = AgentWalletV4(w_);
        usdg.mint(w_, IDLE);
        value = bound(value, 0, 900e6);
        budget = bound(budget, 0, 2_000e6);
        cost = bound(cost, 0, 2_000e6);

        vm.startPrank(operator);
        try w.pay(customer, value, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r", budget, false) {
            assertLe(budget + (budget * markup) / 10_000, value, "a hold was opened for more than was paid");
        } catch {}
        if (refund) {
            try w.refund("r", cost, RCPT) {} catch {}
        } else {
            try w.chargeAndSettle("r", cost, type(uint256).max, RCPT) {} catch {}
        }
        try w.charge("r", cost, RCPT) {} catch {}
        try w.release("r") {} catch {}
        vm.stopPrank();

        (address payer, uint80 paidIn,,) = w.payments("r");
        if (payer == address(0)) paidIn = 0;
        assertLe(usdg.balanceOf(treasury), paidIn, "the treasury got more than the run paid in");
        assertGe(usdg.balanceOf(w_) - w.heldTotal() - w.parkedTotal(), IDLE, "idle money fell");
        assertEq(usdg.balanceOf(treasury) + usdg.balanceOf(w_) + usdg.balanceOf(customer), 1_000e6 + IDLE);
    }
}

/// What the version 4 factory adds: the markup a wallet starts with is named
/// when it is made. Anyone may make a wallet at the published markup; only the
/// operator may make one below it; nobody may make one above it. And a wallet
/// that later adopts the factory's terms keeps the lower of the two markups.
contract V4MarkupTest is V4Base {
    event WalletMarkup(uint256 indexed id, address indexed wallet, uint16 markupBps);
    event TermsAdopted(address indexed treasury, uint16 markupBps);

    function _create(address who, uint16 markup) internal returns (AgentWalletV4) {
        vm.prank(who);
        (, address w) = factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, markup);
        return AgentWalletV4(w);
    }

    function _publish(uint16 markup) internal {
        vm.prank(admin);
        factory.proposeMarkup(markup);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptMarkup();
    }

    function _moveTreasury(address to) internal {
        vm.prank(admin);
        factory.proposeTreasury(to);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptTreasury();
    }

    // ---- who may name which markup ----

    function test_the_operator_may_make_a_wallet_below_the_published_markup() public {
        assertEq(factory.markupBps(), 2_000);
        vm.expectEmit(true, false, false, true, address(factory));
        emit WalletMarkup(3, address(0), 500);
        AgentWalletV4 w = _create(operator, 500);
        assertEq(w.markupBps(), 500);
        assertEq(_create(operator, 1_999).markupBps(), 1_999);
        assertEq(_create(operator, 0).markupBps(), 0);
        assertEq(factory.markupBps(), 2_000, "the published markup is unchanged");
        assertTrue(factory.isAgentWallet(address(w)));

        // And it is billed at its own markup.
        _payTo(w, customer, 6e6, "r1", 5e6);
        vm.prank(operator);
        w.charge("r1", 4e6, RCPT);
        assertEq(usdg.balanceOf(treasury), 4_200_000, "cost plus 5%");
        assertEq(w.withdrawable(), 1_800_000);
    }

    function test_the_operator_may_make_a_wallet_at_the_published_markup() public {
        AgentWalletV4 w = _create(operator, 2_000);
        assertEq(w.markupBps(), 2_000);
        assertEq(w.treasury(), treasury);
    }

    function test_nobody_else_may_make_a_wallet_below_the_published_markup() public {
        address[5] memory who = [carol, alice, admin, guardian, mallory];
        for (uint256 i; i < who.length; i++) {
            vm.startPrank(who[i]);
            vm.expectRevert(ZeroLuxFactoryV4.TermsChanged.selector);
            factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 1_999);
            vm.expectRevert(ZeroLuxFactoryV4.TermsChanged.selector);
            factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 0);
            vm.stopPrank();
        }
        assertEq(factory.agentCount(), 3, "nothing was made");
    }

    function test_anyone_may_make_a_wallet_at_exactly_the_published_markup() public {
        AgentWalletV4 w = _create(mallory, 2_000);
        assertEq(w.markupBps(), 2_000);
        assertEq(w.owner(), carol);
        assertTrue(factory.isAgentWallet(address(w)));
    }

    function test_nobody_may_make_a_wallet_above_the_published_markup() public {
        address[3] memory who = [operator, admin, mallory];
        for (uint256 i; i < who.length; i++) {
            vm.startPrank(who[i]);
            vm.expectRevert(ZeroLuxFactoryV4.MarkupTooHigh.selector);
            factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_001);
            vm.expectRevert(ZeroLuxFactoryV4.MarkupTooHigh.selector);
            factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, type(uint16).max);
            vm.stopPrank();
        }
        assertEq(factory.agentCount(), 3, "nothing was made");
    }

    function testFuzz_the_markup_rule(uint16 published, uint16 asked, bool byOperator, address stranger) public {
        published = uint16(bound(published, 0, 5_000));
        vm.assume(stranger != operator);
        ZeroLuxFactoryV4 f = new ZeroLuxFactoryV4(address(usdg), admin, operator, treasury, published, address(0), guardian);
        vm.prank(byOperator ? operator : stranger);
        if (asked > published) {
            vm.expectRevert(ZeroLuxFactoryV4.MarkupTooHigh.selector);
            f.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, asked);
        } else if (asked < published && !byOperator) {
            vm.expectRevert(ZeroLuxFactoryV4.TermsChanged.selector);
            f.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, asked);
        } else {
            (, address w) = f.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, asked);
            assertEq(AgentWalletV4(w).markupBps(), asked);
            assertTrue(f.isAgentWallet(w));
        }
    }

    function test_the_rule_follows_the_published_markup_and_the_operator_of_the_moment() public {
        _publish(1_000);
        vm.expectRevert(ZeroLuxFactoryV4.MarkupTooHigh.selector);
        factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000); // yesterday's markup
        assertEq(_create(mallory, 1_000).markupBps(), 1_000);
        assertEq(wallet.markupBps(), 2_000, "a wallet made before keeps what it was given");

        // A new operator takes the right with it; the old one loses it.
        address op2 = makeAddr("operator2");
        vm.prank(admin);
        factory.proposeOperator(op2);
        assertEq(_create(operator, 500).markupBps(), 500, "still the operator while the change waits");
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptOperator();
        vm.prank(operator);
        vm.expectRevert(ZeroLuxFactoryV4.TermsChanged.selector);
        factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 500);
        assertEq(_create(op2, 500).markupBps(), 500);
    }

    function test_the_treasury_must_still_be_the_one_the_caller_expects() public {
        vm.expectRevert(ZeroLuxFactoryV4.TermsChanged.selector);
        factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", mallory, 2_000);
        vm.prank(operator);
        vm.expectRevert(ZeroLuxFactoryV4.TermsChanged.selector);
        factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", mallory, 500);
    }

    function test_the_wallet_cannot_be_initialised_again_with_another_markup() public {
        AgentWalletV4 w = _create(operator, 500);
        vm.expectRevert(AgentWalletV4.AlreadyInitialised.selector);
        w.init(mallory, 1, 1, 0);
        assertEq(w.markupBps(), 500);
        assertEq(w.owner(), carol);
    }

    // ---- adopting the factory's terms ----

    function test_a_discounted_wallet_adopts_a_new_treasury_and_keeps_its_discount() public {
        AgentWalletV4 w = _create(operator, 500);
        address t2 = makeAddr("treasury2");
        _moveTreasury(t2);

        vm.startPrank(carol);
        // The owner still names the terms the factory holds, exactly.
        vm.expectRevert(AgentWalletV4.TermsChanged.selector);
        w.adoptTerms(t2, 500);
        vm.expectRevert(AgentWalletV4.TermsChanged.selector);
        w.adoptTerms(treasury, 2_000);
        vm.expectEmit(true, false, false, true, address(w));
        emit TermsAdopted(t2, 500);
        w.adoptTerms(t2, 2_000);
        vm.stopPrank();
        assertEq(w.treasury(), t2);
        assertEq(w.markupBps(), 500, "the discount stands");

        _payTo(w, customer, 6e6, "r1", 5e6);
        vm.prank(operator);
        w.charge("r1", 4e6, RCPT);
        assertEq(usdg.balanceOf(t2), 4_200_000, "billed to the new treasury at the wallet's own 5%");
        assertEq(usdg.balanceOf(treasury), 0);
    }

    function test_when_the_published_markup_drops_below_the_wallets_adopting_lowers_it() public {
        AgentWalletV4 w = _create(operator, 1_500);
        _publish(1_000);
        assertEq(w.markupBps(), 1_500, "nothing changes until the owner adopts");
        assertEq(wallet.markupBps(), 2_000);
        vm.prank(carol);
        w.adoptTerms(treasury, 1_000);
        assertEq(w.markupBps(), 1_000);
        vm.prank(alice);
        wallet.adoptTerms(treasury, 1_000); // a wallet at the old published markup follows it down too
        assertEq(wallet.markupBps(), 1_000);

        // A wallet already below the new markup stays where it is.
        AgentWalletV4 low = _create(operator, 200);
        vm.prank(carol);
        low.adoptTerms(treasury, 1_000);
        assertEq(low.markupBps(), 200);
    }

    function test_adopting_never_raises_a_wallets_markup() public {
        AgentWalletV4 discounted = _create(operator, 500);
        _publish(5_000);
        vm.prank(carol);
        discounted.adoptTerms(treasury, 5_000);
        assertEq(discounted.markupBps(), 500);
        vm.prank(alice);
        wallet.adoptTerms(treasury, 5_000);
        assertEq(wallet.markupBps(), 2_000, "nor that of a wallet made at the old published markup");

        // Down, then the published markup goes back up: the wallet does not follow it.
        _publish(100);
        vm.prank(alice);
        wallet.adoptTerms(treasury, 100);
        assertEq(wallet.markupBps(), 100);
        _publish(3_000);
        vm.prank(alice);
        wallet.adoptTerms(treasury, 3_000);
        assertEq(wallet.markupBps(), 100);
    }

    function testFuzz_adopting_gives_the_lower_of_the_two_markups(uint16 own, uint16 published) public {
        own = uint16(bound(own, 0, 2_000));
        published = uint16(bound(published, 0, 5_000));
        AgentWalletV4 w = _create(operator, own);
        _publish(published);
        vm.prank(carol);
        w.adoptTerms(treasury, published);
        assertEq(w.markupBps(), own < published ? own : published);
        assertLe(w.markupBps(), own, "never above what it had");
    }

    function test_under_a_lien_adopting_still_needs_the_payees_yes_to_the_published_terms() public {
        AgentWalletV4 w = _create(operator, 500);
        address t2 = makeAddr("treasury2");
        vm.prank(carol);
        w.setLien(lender, 5_000, 0);
        _moveTreasury(t2);
        vm.prank(carol);
        vm.expectRevert(AgentWalletV4.LienExists.selector);
        w.adoptTerms(t2, 2_000);
        vm.prank(lender);
        w.consentToTerms(t2, 500); // a yes to other terms is not a yes to these
        vm.prank(carol);
        vm.expectRevert(AgentWalletV4.LienExists.selector);
        w.adoptTerms(t2, 2_000);
        vm.prank(lender);
        w.consentToTerms(t2, 2_000);
        vm.prank(carol);
        w.adoptTerms(t2, 2_000);
        assertEq(w.treasury(), t2);
        assertEq(w.markupBps(), 500);
        vm.prank(carol);
        vm.expectRevert(AgentWalletV4.LienExists.selector);
        w.adoptTerms(t2, 2_000); // the yes is used up
    }

    function test_only_the_owner_adopts() public {
        AgentWalletV4 w = _create(operator, 500);
        vm.prank(operator);
        vm.expectRevert(AgentWalletV4.NotOwner.selector);
        w.adoptTerms(treasury, 2_000);
    }
}
