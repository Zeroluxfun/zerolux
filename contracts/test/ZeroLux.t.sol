// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactory} from "../src/ZeroLuxFactory.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {ZeroLuxTreasury} from "../src/ZeroLuxTreasury.sol";

contract MockUSDG {
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ZeroLuxTest is Test {
    MockUSDG usdg;
    ZeroLuxFactory factory;
    AgentWallet wallet;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // agent owner
    address mallory = makeAddr("mallory");

    uint128 constant RUN_CAP = 1e6; // $1
    uint128 constant DAY_CAP = 5e6; // $5

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        factory = new ZeroLuxFactory(address(usdg), admin, operator, treasury, 2_000, address(0));
        (, address w) = factory.createAgent(alice, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWallet(w);
        usdg.mint(w, 100e6);
    }

    // ---- creation ----

    function test_createAgent_registers() public view {
        assertEq(factory.agentCount(), 1);
        assertTrue(factory.isAgentWallet(address(wallet)));
        assertEq(wallet.owner(), alice);
        assertEq(wallet.factory(), address(factory));
        assertEq(wallet.perRunCap(), RUN_CAP);
        assertEq(factory.agent(0).specHash, keccak256("spec"));
    }

    function test_wallet_cannot_be_initialised_twice() public {
        vm.expectRevert(AgentWallet.AlreadyInitialised.selector);
        wallet.init(mallory, 1, 1);
    }

    function test_implementation_is_locked() public {
        AgentWallet impl = AgentWallet(factory.walletImplementation());
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.AlreadyInitialised.selector);
        impl.init(mallory, 1, 1);
    }

    function test_two_agents_get_distinct_wallets() public {
        (uint256 id, address w2) = factory.createAgent(alice, 1, 1, bytes32(0), "", treasury, 2_000);
        assertEq(id, 1);
        assertTrue(w2 != address(wallet));
    }

    // ---- charging ----

    function test_charge_pays_treasury_cost_plus_markup() public {
        vm.prank(operator);
        wallet.charge("run1", 500_000); // $0.50 cost, 20% fee
        assertEq(usdg.balanceOf(treasury), 600_000);
        assertEq(usdg.balanceOf(address(wallet)), 100e6 - 600_000);
        assertEq(wallet.totalCharged(), 600_000);
    }

    function test_only_operator_can_charge() public {
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOperator.selector);
        wallet.charge("run1", 1);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.NotOperator.selector);
        wallet.charge("run1", 1);
    }

    function test_run_cannot_be_charged_twice() public {
        vm.startPrank(operator);
        wallet.charge("run1", 100_000);
        vm.expectRevert(AgentWallet.RunAlreadyCharged.selector);
        wallet.charge("run1", 100_000);
    }

    function test_run_cap_counts_the_fee() public {
        vm.startPrank(operator);
        vm.expectRevert(AgentWallet.OverRunCap.selector);
        wallet.charge("run1", 900_000); // 900k + 180k fee > $1
        wallet.charge("run2", 833_333); // 833,333 + 166,666 = 999,999
    }

    function test_day_cap_holds_and_resets_next_day() public {
        vm.startPrank(operator);
        for (uint256 i; i < 6; ++i) {
            wallet.charge(bytes32(i + 1), 694_444); // 833,332 each with fee; six = 4,999,992
        }
        vm.expectRevert(AgentWallet.OverDayCap.selector);
        wallet.charge("more", 10);
        assertEq(wallet.remainingToday(), 8);
        vm.warp(block.timestamp + 1 days);
        wallet.charge("tomorrow", 10);
        assertEq(usdg.balanceOf(treasury), 4_999_992 + 12);
    }

    function test_stolen_operator_key_is_bounded_and_cannot_pick_the_payee() public {
        // The worst a stolen operator key can do in a day is the day cap, and it lands in the treasury.
        vm.startPrank(operator);
        uint256 n;
        while (true) {
            try wallet.charge(bytes32(++n), 833_333) {} catch { break; }
        }
        assertLe(usdg.balanceOf(treasury), DAY_CAP);
        assertEq(usdg.balanceOf(mallory), 0);
        assertEq(usdg.balanceOf(operator), 0);
    }

    function test_zero_cost_rejected() public {
        vm.prank(operator);
        vm.expectRevert(AgentWallet.ZeroCost.selector);
        wallet.charge("run1", 0);
    }

    function test_pause_stops_charges() public {
        vm.prank(alice);
        wallet.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.Paused.selector);
        wallet.charge("run1", 1);
    }

    function test_charge_fails_cleanly_when_wallet_is_empty() public {
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 100e6);
        vm.prank(operator);
        vm.expectRevert();
        wallet.charge("run1", 100_000);
    }

    function test_markup_change_reaches_a_wallet_only_when_its_owner_adopts_it() public {
        vm.prank(admin);
        factory.setMarkup(5_000);
        vm.prank(operator);
        wallet.charge("run1", 500_000);
        assertEq(usdg.balanceOf(treasury), 600_000); // still 20%
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.adoptTerms(treasury, 5_000);
        vm.prank(alice);
        wallet.adoptTerms(treasury, 5_000);
        vm.prank(operator);
        wallet.charge("run2", 500_000);
        assertEq(usdg.balanceOf(treasury), 600_000 + 750_000);
    }

    function test_new_agents_get_the_current_terms() public {
        vm.prank(admin);
        factory.setMarkup(1_000);
        (, address w2) = factory.createAgent(alice, RUN_CAP, DAY_CAP, bytes32(0), "", treasury, 1_000);
        assertEq(AgentWallet(w2).markupBps(), 1_000);
        assertEq(AgentWallet(w2).treasury(), treasury);
        assertEq(wallet.markupBps(), 2_000);
    }

    // ---- the owner's money ----

    function test_owner_withdraws_everything_at_once() public {
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 100e6);
        assertEq(usdg.balanceOf(alice), 100e6);
    }

    function test_owner_can_withdraw_while_paused() public {
        vm.startPrank(alice);
        wallet.setPaused(true);
        wallet.withdraw(address(usdg), alice, 1e6);
        assertEq(usdg.balanceOf(alice), 1e6);
    }

    function test_nobody_else_can_withdraw_or_change_limits() public {
        address[3] memory who = [mallory, operator, admin];
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(AgentWallet.NotOwner.selector);
            wallet.withdraw(address(usdg), who[i], 1);
            vm.expectRevert(AgentWallet.NotOwner.selector);
            wallet.setLimits(type(uint128).max, type(uint128).max);
            vm.expectRevert(AgentWallet.NotOwner.selector);
            wallet.setPaused(false);
            vm.expectRevert(AgentWallet.NotOwner.selector);
            wallet.transferOwnership(who[i]);
            vm.stopPrank();
        }
    }

    function test_owner_sets_limits_to_zero_to_block_all_charges() public {
        vm.prank(alice);
        wallet.setLimits(0, 0);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.OverRunCap.selector);
        wallet.charge("run1", 1);
    }

    function test_wallet_ownership_is_two_step() public {
        address bob = makeAddr("bob");
        vm.prank(alice);
        wallet.transferOwnership(bob);
        assertEq(wallet.owner(), alice);
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.acceptOwnership();
        vm.prank(bob);
        wallet.acceptOwnership();
        assertEq(wallet.owner(), bob);
    }

    // ---- factory settings ----

    function test_markup_is_capped() public {
        vm.prank(admin);
        vm.expectRevert(ZeroLuxFactory.MarkupTooHigh.selector);
        factory.setMarkup(5_001);
    }

    function test_only_admin_changes_settings() public {
        vm.startPrank(mallory);
        vm.expectRevert(ZeroLuxFactory.NotOwner.selector);
        factory.setOperator(mallory);
        vm.expectRevert(ZeroLuxFactory.NotOwner.selector);
        factory.setMarkup(0);
        vm.expectRevert(ZeroLuxFactory.NotOwner.selector);
        factory.proposeTreasury(mallory);
        vm.expectRevert(ZeroLuxFactory.NotOwner.selector);
        factory.transferOwnership(mallory);
    }

    function test_operator_can_be_replaced_at_once() public {
        address fresh = makeAddr("fresh");
        vm.prank(admin);
        factory.setOperator(fresh);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.NotOperator.selector);
        wallet.charge("run1", 1);
        vm.prank(fresh);
        wallet.charge("run1", 1);
    }

    function test_treasury_change_waits_two_days() public {
        address next = makeAddr("next");
        vm.startPrank(admin);
        vm.expectRevert(ZeroLuxFactory.NothingPending.selector);
        factory.acceptTreasury();
        factory.proposeTreasury(next);
        vm.expectRevert(ZeroLuxFactory.TooEarly.selector);
        factory.acceptTreasury();
        vm.warp(block.timestamp + 2 days - 1);
        vm.expectRevert(ZeroLuxFactory.TooEarly.selector);
        factory.acceptTreasury();
        vm.warp(block.timestamp + 1);
        factory.acceptTreasury();
        vm.stopPrank();
        assertEq(factory.treasury(), next);
        // An existing wallet keeps paying the treasury it was made with...
        vm.prank(operator);
        wallet.charge("run1", 100_000);
        assertEq(usdg.balanceOf(next), 0);
        assertEq(usdg.balanceOf(treasury), 120_000);
        // ...until its owner adopts the change.
        {
            address t_ = factory.treasury();
            uint16 m_ = factory.markupBps();
            vm.prank(alice);
            wallet.adoptTerms(t_, m_);
        }
        vm.prank(operator);
        wallet.charge("run2", 100_000);
        assertEq(usdg.balanceOf(next), 120_000);
    }

    function test_stolen_factory_owner_key_cannot_redirect_or_reprice_existing_wallets() public {
        // The thief takes the factory, becomes operator and treasury, and sets the highest markup.
        vm.startPrank(admin);
        factory.transferOwnership(mallory);
        vm.stopPrank();
        vm.startPrank(mallory);
        factory.acceptOwnership();
        factory.setOperator(mallory);
        factory.setMarkup(5_000);
        factory.proposeTreasury(mallory);
        vm.warp(block.timestamp + 2 days);
        factory.acceptTreasury();
        // Charges still land in the original treasury at the original markup.
        wallet.charge("theft", 500_000);
        vm.stopPrank();
        assertEq(usdg.balanceOf(mallory), 0);
        assertEq(usdg.balanceOf(treasury), 600_000);
        // And the wallet owner can still leave.
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 100e6 - 600_000);
        assertEq(usdg.balanceOf(address(wallet)), 0);
    }

    function test_wallet_address_depends_only_on_the_creator() public {
        // Someone else creating agents in between does not change the address a creator gets next.
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        (, address expected) = factory.createAgent(alice, 1, 1, bytes32(0), "", treasury, 2_000);
        vm.revertToState(snap);
        vm.prank(mallory);
        factory.createAgent(mallory, 1, 1, bytes32(0), "", treasury, 2_000);
        vm.prank(alice);
        (, address got) = factory.createAgent(alice, 1, 1, bytes32(0), "", treasury, 2_000);
        assertEq(got, expected);
    }

    function test_adoptTerms_only_takes_the_values_the_owner_named() public {
        vm.prank(admin);
        factory.setMarkup(1_000); // announced
        vm.prank(admin);
        factory.setMarkup(5_000); // swapped just before the owner's transaction lands
        vm.prank(alice);
        vm.expectRevert(AgentWallet.TermsChanged.selector);
        wallet.adoptTerms(treasury, 1_000);
        assertEq(wallet.markupBps(), 2_000);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.TermsChanged.selector);
        wallet.adoptTerms(mallory, 5_000);
        assertEq(wallet.treasury(), treasury);
    }

    function test_treasury_contract_holds_charges_and_only_its_owner_withdraws() public {
        ZeroLuxTreasury t = new ZeroLuxTreasury(admin);
        ZeroLuxFactory f2 = new ZeroLuxFactory(address(usdg), admin, operator, address(t), 2_000, address(0));
        (, address w) = f2.createAgent(alice, RUN_CAP, DAY_CAP, bytes32(0), "", f2.treasury(), f2.markupBps());
        usdg.mint(w, 10e6);
        vm.prank(operator);
        AgentWallet(w).charge("run1", 500_000);
        assertEq(usdg.balanceOf(address(t)), 600_000);
        vm.prank(mallory);
        vm.expectRevert(ZeroLuxTreasury.NotOwner.selector);
        t.withdraw(address(usdg), mallory, 1);
        vm.prank(admin);
        t.withdraw(address(usdg), admin, 600_000);
        assertEq(usdg.balanceOf(admin), 600_000);
        // The key can be rotated without the treasury address changing.
        address next = makeAddr("nextAdmin");
        vm.prank(admin);
        t.transferOwnership(next);
        vm.prank(next);
        t.acceptOwnership();
        vm.prank(admin);
        vm.expectRevert(ZeroLuxTreasury.NotOwner.selector);
        t.withdraw(address(usdg), admin, 0);
        // ETH sent by mistake can be taken out too.
        vm.deal(address(t), 1 ether);
        vm.prank(next);
        t.withdraw(address(0), next, 1 ether);
        assertEq(next.balance, 1 ether);
    }

    // ---- properties ----

    function testFuzz_charge_never_exceeds_caps_or_pays_anyone_but_treasury(uint96 cost, uint16 markup) public {
        markup = uint16(bound(markup, 0, 5_000));
        cost = uint96(bound(cost, 1, 10e6));
        vm.prank(admin);
        factory.setMarkup(markup);
        {
            address t_ = factory.treasury();
            uint16 m_ = factory.markupBps();
            vm.prank(alice);
            wallet.adoptTerms(t_, m_);
        }
        uint256 before = usdg.balanceOf(address(wallet));
        vm.prank(operator);
        try wallet.charge("fuzz", cost) {
            uint256 paid = before - usdg.balanceOf(address(wallet));
            assertLe(paid, RUN_CAP);
            assertEq(paid, usdg.balanceOf(treasury));
            assertEq(paid, uint256(cost) + (uint256(cost) * markup) / 10_000);
        } catch {
            assertEq(usdg.balanceOf(address(wallet)), before);
        }
    }
}
