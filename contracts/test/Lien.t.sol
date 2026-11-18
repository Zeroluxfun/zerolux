// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactory} from "../src/ZeroLuxFactory.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {MockUSDG} from "./ZeroLux.t.sol";

contract LienTest is Test {
    MockUSDG usdg;
    ZeroLuxFactory factory;
    AgentWallet wallet;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // agent owner
    address lender = makeAddr("lender");
    address mallory = makeAddr("mallory");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        factory = new ZeroLuxFactory(address(usdg), admin, operator, treasury, 2_000, address(0));
        (, address w) = factory.createAgent(alice, 10e6, 1_000e6, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWallet(w);
    }

    /// Money arrives and the meter counts it as settled.
    function _earn(uint256 amount) internal {
        usdg.mint(address(wallet), amount);
        vm.prank(operator);
        wallet.settle(type(uint256).max);
    }

    /// Money arrives for a run that has not been billed yet.
    function _earnUnbilled(uint256 amount) internal {
        usdg.mint(address(wallet), amount);
    }

    function _charge(bytes32 id, uint256 cost) internal {
        vm.prank(operator);
        wallet.charge(id, cost);
    }

    // ---- the record ----

    function test_income_and_profit_track_money_in_and_run_costs() public {
        _earn(10e6);
        assertEq(wallet.income(), 10e6);
        assertEq(wallet.profit(), 10e6);
        _charge("r1", 1e6); // $1 cost + 20% = $1.20
        assertEq(wallet.income(), 10e6, "paying a run is not income");
        assertEq(wallet.profit(), 8_800_000);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 5e6);
        assertEq(wallet.income(), 10e6, "a withdrawal does not change income");
        assertEq(wallet.profit(), 8_800_000, "a withdrawal does not change profit");
    }

    function test_no_lien_means_owner_withdraws_everything() public {
        _earn(10e6);
        assertEq(wallet.withdrawable(), 10e6);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 10e6);
        assertEq(usdg.balanceOf(alice), 10e6);
    }

    // ---- setting a lien ----

    function test_only_owner_sets_a_lien() public {
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.setLien(mallory, 10_000, 0);
    }

    function test_lien_rejects_bad_terms() public {
        vm.startPrank(alice);
        vm.expectRevert(AgentWallet.ZeroAddress.selector);
        wallet.setLien(address(0), 1_000, 0);
        vm.expectRevert(AgentWallet.ZeroAddress.selector);
        wallet.setLien(address(wallet), 1_000, 0);
        vm.expectRevert(AgentWallet.BadLien.selector);
        wallet.setLien(lender, 0, 0);
        vm.expectRevert(AgentWallet.BadLien.selector);
        wallet.setLien(lender, 10_001, 0);
        vm.stopPrank();
    }

    function test_one_lien_at_a_time_and_it_cannot_be_replaced() public {
        vm.startPrank(alice);
        wallet.setLien(lender, 3_000, 0);
        vm.expectRevert(AgentWallet.LienExists.selector);
        wallet.setLien(alice, 1, 0);
        vm.stopPrank();
    }

    function test_lien_only_counts_profit_made_after_it_starts() public {
        _earn(10e6);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        assertEq(wallet.lienUnpaid(), 0, "money earned before the lien is the owner's");
        assertEq(wallet.withdrawable(), 10e6);
        _earn(4e6);
        assertEq(wallet.lienUnpaid(), 2e6);
        assertEq(wallet.withdrawable(), 12e6);
    }

    // ---- holding back and paying ----

    function test_owner_cannot_withdraw_the_pledged_share() public {
        vm.prank(alice);
        wallet.setLien(lender, 3_000, 0);
        _earn(10e6);
        assertEq(wallet.withdrawable(), 7e6);
        vm.startPrank(alice);
        vm.expectRevert(AgentWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 7e6 + 1);
        wallet.withdraw(address(usdg), alice, 7e6);
        vm.expectRevert(AgentWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(wallet)), 3e6);
    }

    function test_anyone_can_settle_and_the_money_goes_only_to_the_payee() public {
        vm.prank(alice);
        wallet.setLien(lender, 3_000, 0);
        _earn(10e6);
        vm.prank(mallory);
        uint256 paid = wallet.settleLien();
        assertEq(paid, 3e6);
        assertEq(usdg.balanceOf(lender), 3e6);
        assertEq(usdg.balanceOf(mallory), 0);
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(wallet.withdrawable(), 7e6);
        assertEq(wallet.settleLien(), 0, "settling twice pays nothing more");
        assertEq(usdg.balanceOf(lender), 3e6);
    }

    function test_settle_without_a_lien_reverts() public {
        vm.expectRevert(AgentWallet.NoLien.selector);
        wallet.settleLien();
    }

    function test_lien_is_on_profit_so_run_costs_come_first() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(10e6);
        _charge("r1", 5e6); // $6 with the fee
        assertEq(wallet.profit(), 4e6);
        assertEq(wallet.lienUnpaid(), 2e6);
        assertEq(wallet.withdrawable(), 2e6);
    }

    function test_owner_topping_up_for_compute_is_not_taxed_once_spent() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(6e6); // the owner's own money, sent in to pay for runs
        _charge("r1", 5e6); // all $6 goes on a run
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(usdg.balanceOf(address(wallet)), 0);
    }

    function test_a_loss_after_a_payment_must_be_earned_back_before_more_is_owed() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(10e6);
        wallet.settleLien(); // lender has $5
        _charge("r1", 2_500_000); // $3 cost: profit falls to $7, lien earned $3.50, already paid $5
        assertEq(wallet.lienUnpaid(), 0);
        _earn(2e6); // profit $9, earned $4.50: still under what was paid
        assertEq(wallet.lienUnpaid(), 0);
        _earn(2e6); // profit $11, earned $5.50
        assertEq(wallet.lienUnpaid(), 500_000);
    }

    function test_a_charge_may_use_money_held_for_the_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        _earn(6e6);
        assertEq(wallet.withdrawable(), 0);
        _charge("r1", 5e6);
        assertEq(usdg.balanceOf(treasury), 6e6);
        assertEq(wallet.lienUnpaid(), 0);
    }

    function test_cap_limits_what_the_lien_ever_pays() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 3e6);
        _earn(100e6);
        assertEq(wallet.lienUnpaid(), 3e6);
        wallet.settleLien();
        _earn(100e6);
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(usdg.balanceOf(lender), 3e6);
    }

    function test_other_tokens_are_never_held_back() public {
        MockUSDG other = new MockUSDG();
        other.mint(address(wallet), 5e6);
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        _earn(1e6);
        vm.prank(alice);
        wallet.withdraw(address(other), alice, 5e6);
        assertEq(other.balanceOf(alice), 5e6);
    }

    // ---- ending ----

    function test_owner_cannot_end_a_lien_that_has_not_paid_its_cap() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 3e6);
        _earn(4e6); // lien has earned $2 of its $3
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienStands.selector);
        wallet.endLien();
        assertEq(usdg.balanceOf(lender), 0, "a failed exit pays nothing by the back door");
    }

    function test_owner_can_never_end_a_lien_with_no_cap() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(1_000e6);
        wallet.settleLien();
        vm.warp(block.timestamp + 3650 days);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienStands.selector);
        wallet.endLien();
    }

    function test_stranger_cannot_end_a_lien_even_when_it_is_capped_out() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 3e6);
        _earn(10e6);
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.endLien();
    }

    function test_owner_cannot_end_a_capped_lien_while_the_wallet_is_short_of_what_is_owed() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 3e6);
        _earn(10e6);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 7e6);
        _charge("r1", 2e6); // $2.40 comes out of the $3 held: profit $7.60, lien still owed $3
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienStands.selector);
        wallet.endLien();
    }

    function test_dust_and_unsettled_income_cannot_stop_a_capped_out_exit() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 3e6);
        _earn(10e6);
        _earnUnbilled(1); // dust
        _earnUnbilled(50e6); // a real unbilled payment
        vm.prank(alice);
        wallet.endLien();
        assertEq(usdg.balanceOf(lender), 3e6);
        assertEq(wallet.withdrawable(), 57e6 + 1, "with the lien gone nothing is held");
    }

    function test_owner_ends_a_capped_out_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 3e6);
        _earn(10e6);
        vm.prank(alice);
        wallet.endLien(); // pays the $3 and clears
        assertEq(usdg.balanceOf(lender), 3e6);
        assertEq(wallet.withdrawable(), 7e6);
        (address payee,,,,) = wallet.lien();
        assertEq(payee, address(0));
    }

    function test_payee_can_release_at_any_time() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(10e6);
        wallet.settleLien();
        vm.prank(lender);
        wallet.endLien();
        assertEq(usdg.balanceOf(lender), 5e6);
        assertEq(wallet.withdrawable(), 5e6);
        vm.prank(alice);
        wallet.setLien(mallory, 1_000, 0); // a new lien is possible afterwards
    }

    function test_new_owner_inherits_the_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(alice);
        wallet.transferOwnership(mallory);
        vm.prank(mallory);
        wallet.acceptOwnership();
        _earn(10e6);
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), mallory, 5e6 + 1);
    }

    // ---- no path lets the owner take the pledged share ----

    function testFuzz_owner_never_takes_the_pledged_share(
        uint16 bps,
        uint64[6] memory earns,
        uint64[6] memory costs,
        uint64[6] memory takes,
        bool[6] memory settles
    ) public {
        bps = uint16(bound(bps, 1, 10_000));
        vm.prank(alice);
        wallet.setLien(lender, bps, 0);
        vm.prank(alice);
        wallet.setLimits(type(uint128).max, type(uint128).max);

        for (uint256 i = 0; i < 6; i++) {
            _earn(bound(earns[i], 0, 1_000e6));
            uint256 cost = bound(costs[i], 0, 100e6);
            if (cost != 0 && cost + (cost * 2_000) / 10_000 <= usdg.balanceOf(address(wallet))) {
                _charge(bytes32(i + 1), cost);
            }
            uint256 take = bound(takes[i], 0, 2_000e6);
            vm.prank(alice);
            try wallet.withdraw(address(usdg), alice, take) {} catch {}
            if (settles[i]) wallet.settleLien();
        }

        // Whatever happened: lender's payments plus what is still held for them
        // never fall short of their share of final profit, unless run costs
        // (which come first) used the money.
        uint256 earned = (wallet.profit() * bps) / 10_000;
        uint256 got = usdg.balanceOf(lender);
        uint256 held = usdg.balanceOf(address(wallet));
        if (got < earned) {
            uint256 short = earned - got;
            // the owner could not have withdrawn while this was owed
            assertEq(wallet.withdrawable(), held > short ? held - short : 0);
            if (held < short) {
                vm.prank(alice);
                vm.expectRevert(AgentWallet.LienOwed.selector);
                wallet.withdraw(address(usdg), alice, 1);
            }
        }
        // books balance: every dollar in is with the treasury, the lender, the owner or the wallet
        assertEq(
            wallet.income(), usdg.balanceOf(treasury) + got + usdg.balanceOf(alice) + held, "books do not balance"
        );
    }

    // ---- settled profit: the checkpoint ----

    function test_unbilled_income_pays_nobody_until_it_is_settled() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earnUnbilled(100e6);
        assertEq(wallet.unsettled(), 100e6);
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(wallet.settleLien(), 0, "the payee cannot be paid on money whose run is not billed");
        assertEq(wallet.withdrawable(), 0, "nor can the owner take it");
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);

        vm.prank(alice);
        wallet.setLimits(100e6, 1_000e6);
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 40e6, type(uint256).max); // $48 with the fee; nothing else is waiting
        assertEq(wallet.profit(), 52e6);
        assertEq(wallet.lienUnpaid(), 26e6);
        assertEq(wallet.withdrawable(), 26e6);
        wallet.settleLien();
        assertEq(usdg.balanceOf(lender), 26e6, "exactly half of real profit");
        assertEq(usdg.balanceOf(treasury), 48e6, "the run was paid for in full");
    }

    function test_money_for_other_unbilled_runs_stays_held_after_a_charge() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earnUnbilled(10e6); // run 1
        _earnUnbilled(10e6); // run 2
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 5e6, 4e6); // profit will be $14, of which run 2's $10 is still unbilled
        assertEq(wallet.profit(), 14e6);
        assertEq(wallet.settledProfit(), 4e6);
        assertEq(wallet.lienUnpaid(), 2e6);
        assertEq(wallet.withdrawable(), 2e6);
        vm.prank(operator);
        wallet.chargeAndSettle("r2", 5e6, type(uint256).max);
        assertEq(wallet.lienUnpaid(), 4e6);
        assertEq(wallet.withdrawable(), 4e6);
    }

    function test_only_the_operator_moves_the_checkpoint_directly() public {
        vm.expectRevert(AgentWallet.NotOperator.selector);
        wallet.settle(0);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.NotOperator.selector);
        wallet.chargeAndSettle("r1", 1, 0);
    }

    function test_if_the_meter_goes_quiet_anyone_gets_a_checkpoint_after_a_day() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earnUnbilled(10e6);
        vm.expectRevert(AgentWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
        wallet.requestCheckpoint();
        vm.expectRevert(AgentWallet.CheckpointPending.selector);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(AgentWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
        vm.warp(block.timestamp + 1);
        _earnUnbilled(6e6); // arrived after the request: not part of it
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 10e6);
        assertEq(wallet.lienUnpaid(), 5e6);
        assertEq(wallet.withdrawable(), 5e6);
    }

    function test_a_requested_checkpoint_cannot_jump_ahead_of_a_run_billed_meanwhile() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earnUnbilled(10e6);
        wallet.requestCheckpoint(); // owner or payee tries to settle gross income
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 5e6, type(uint256).max); // the meter bills it within the day: request is void
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(AgentWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 4e6);
    }

    function test_a_checkpoint_taken_after_a_charge_never_exceeds_real_profit() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earnUnbilled(10e6);
        wallet.requestCheckpoint();
        vm.prank(operator);
        wallet.charge("r1", 5e6); // plain charge: does not move or cancel the checkpoint
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 4e6, "the lower of what was asked and what is real");
    }

    function test_a_hostile_meter_can_freeze_fresh_income_but_takes_nothing_and_the_fallback_frees_it() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(10e6);
        vm.prank(operator);
        wallet.settle(0); // claims nothing is settled
        assertEq(wallet.settledProfit(), 0);
        assertEq(wallet.withdrawable(), 0);
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(usdg.balanceOf(address(wallet)), 10e6, "nothing left the wallet");
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();
        assertEq(wallet.lienUnpaid(), 5e6);
        assertEq(wallet.withdrawable(), 5e6);
    }

    function test_with_no_lien_the_owner_withdraws_unsettled_income_too() public {
        _earnUnbilled(10e6);
        assertEq(wallet.withdrawable(), 10e6);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 10e6);
    }

    // ---- other fixes from review ----

    function test_terms_cannot_be_adopted_while_a_lien_stands() public {
        vm.prank(admin);
        factory.setMarkup(100);
        vm.startPrank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.expectRevert(AgentWallet.LienExists.selector);
        wallet.adoptTerms(treasury, 100);
        vm.stopPrank();
    }

    function test_terms_can_be_adopted_under_a_lien_once_the_payee_agrees_to_exactly_those() public {
        vm.prank(admin);
        factory.setMarkup(100);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.consentToTerms(treasury, 100);
        vm.prank(lender);
        wallet.consentToTerms(treasury, 200); // agrees to something else
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienExists.selector);
        wallet.adoptTerms(treasury, 100);
        vm.prank(lender);
        wallet.consentToTerms(treasury, 100);
        vm.prank(alice);
        wallet.adoptTerms(treasury, 100);
        assertEq(wallet.markupBps(), 100);
        assertEq(wallet.lienTermsConsent(), bytes32(0), "a yes is used once");
    }

    // ---- second review ----

    function test_plain_charge_pulls_the_checkpoint_down_so_new_income_is_not_presettled() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(200e6);
        vm.prank(alice);
        wallet.setLimits(100e6, 1_000e6);
        vm.prank(operator);
        wallet.charge("r1", 40e6);
        assertEq(wallet.settledProfit(), 152e6);
        _earnUnbilled(48e6);
        assertEq(wallet.unsettled(), 48e6);
    }

    function test_a_payment_racing_the_meter_is_not_counted_as_settled() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        // the meter saw an empty wallet and signed settle(0); $100 lands first
        _earnUnbilled(100e6);
        vm.prank(operator);
        wallet.settle(0);
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(wallet.withdrawable(), 0);
    }

    function test_holding_the_checkpoint_at_zero_never_freezes_money_from_before_the_lien() public {
        _earnUnbilled(1_000e6);
        vm.prank(alice);
        wallet.setLien(lender, 1, 0);
        vm.prank(operator);
        wallet.settle(0);
        assertEq(wallet.withdrawable(), 1_000e6);
    }

    function test_payee_can_repoint_the_lien_and_only_the_payee() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.setLienPayee(alice);
        vm.prank(lender);
        wallet.setLienPayee(mallory);
        _earn(10e6);
        wallet.settleLien();
        assertEq(usdg.balanceOf(mallory), 5e6);
        assertEq(usdg.balanceOf(lender), 0);
    }

    function test_withdrawing_to_the_wallet_itself_is_refused() public {
        _earn(1e6);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.ZeroAddress.selector);
        wallet.withdraw(address(usdg), address(wallet), 1e6);
        assertEq(wallet.income(), 1e6);
    }

    function test_creation_fails_if_terms_are_not_what_the_caller_expects() public {
        vm.prank(admin);
        factory.setMarkup(5_000);
        vm.expectRevert(ZeroLuxFactory.TermsChanged.selector);
        factory.createAgent(alice, 1, 1, bytes32(0), "", treasury, 2_000);
        vm.expectRevert(ZeroLuxFactory.TermsChanged.selector);
        factory.createAgent(alice, 1, 1, bytes32(0), "", mallory, 5_000);
        factory.createAgent(alice, 1, 1, bytes32(0), "", treasury, 5_000);
    }
}

/// USDG that refuses to pay chosen addresses.
contract BlockingUSDG is MockUSDG {
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool on) external {
        blocked[who] = on;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(!blocked[to] && !blocked[msg.sender], "blocked");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract LienBlockedPayeeTest is Test {
    BlockingUSDG usdg;
    ZeroLuxFactory factory;
    AgentWallet wallet;
    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address lender = makeAddr("lender");
    address frozen = makeAddr("frozen");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new BlockingUSDG();
        factory = new ZeroLuxFactory(address(usdg), admin, operator, treasury, 2_000, address(0));
        (, address w) = factory.createAgent(alice, 10e6, 1_000e6, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWallet(w);
        usdg.setBlocked(frozen, true);
    }

    function _earn(uint256 amount) internal {
        usdg.mint(address(wallet), amount);
        vm.prank(operator);
        wallet.settle(type(uint256).max);
    }

    function test_owner_ends_a_capped_out_lien_even_if_usdg_will_not_pay_the_payee() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 500e6);
        vm.prank(lender);
        wallet.setLienPayee(frozen); // a hostile payee points the lien at an address that cannot be paid
        _earn(1_000e6);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.settleLien();
        vm.prank(alice);
        wallet.endLien();
        assertEq(wallet.parked(frozen), 500e6, "the payee's share is set aside, not lost and not the owner's");
        assertEq(wallet.withdrawable(), 500e6);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 500e6 + 1);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 500e6);
        // run charges cannot spend what is set aside
        vm.prank(operator);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.charge("r1", 1e6);
        // the payee collects to an address that works; nobody else can
        vm.prank(alice);
        vm.expectRevert(AgentWallet.NoLien.selector);
        wallet.claimParked(alice);
        vm.prank(frozen);
        wallet.claimParked(lender);
        assertEq(usdg.balanceOf(lender), 500e6);
        assertEq(wallet.parkedTotal(), 0);
        assertEq(wallet.income(), 1_000e6, "books still balance");
    }

    function test_new_lien_after_parking_keeps_the_parked_money_apart() public {
        vm.prank(alice);
        wallet.setLien(frozen, 5_000, 50e6);
        _earn(100e6);
        vm.prank(alice);
        wallet.endLien();
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        _earn(10e6);
        assertEq(wallet.settleLien(), 10e6);
        assertEq(usdg.balanceOf(lender), 10e6);
        assertEq(wallet.parked(frozen), 50e6);
        assertEq(wallet.withdrawable(), 50e6);
    }

    function test_consent_to_terms_does_not_pass_to_a_new_payee() public {
        vm.prank(admin);
        factory.setMarkup(5_000);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(lender);
        wallet.consentToTerms(treasury, 5_000);
        vm.prank(lender);
        wallet.setLienPayee(frozen);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienExists.selector);
        wallet.adoptTerms(treasury, 5_000);
    }
}
