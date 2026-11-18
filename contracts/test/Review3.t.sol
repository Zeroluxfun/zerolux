// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactory} from "../src/ZeroLuxFactory.sol";
import {AgentWallet} from "../src/AgentWallet.sol";

/// Third independent review, round 4 (checkpoint, capped exit, parking; no date expiry). Every test passes when the
/// behaviour in its name is real. test_r3_FINDING_* show something wrong in the current
/// code; test_r3_closed_* show a round-1 finding that no longer works; test_r3_held_*
/// show an attack that failed.

/// USDG stand-in with an issuer blacklist (both directions, like most regulated stablecoins).
contract BlockableUSDG {
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[msg.sender] && !blocked[to], "blocked");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

interface IReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

/// Honest minimal ERC-8004-like registry: safe-mints to the caller.
contract Registry {
    mapping(uint256 => address) public ownerOf;
    uint256 public next = 1;

    function register(string calldata) external virtual returns (uint256 id) {
        id = next++;
        ownerOf[id] = msg.sender;
        _check(address(0), msg.sender, id);
    }

    function mintTo(address to) external returns (uint256 id) {
        id = next++;
        ownerOf[id] = to;
    }

    function transferFrom(address from, address to, uint256 id) public virtual {
        require(ownerOf[id] == from && msg.sender == from, "not owner");
        ownerOf[id] = to;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        _check(from, to, id);
    }

    function _check(address from, address to, uint256 id) internal {
        if (to.code.length != 0) {
            require(IReceiver(to).onERC721Received(msg.sender, from, id, "") == 0x150b7a02, "refused");
        }
    }
}

/// Registry that always reverts.
contract DeadRegistry {
    function register(string calldata) external pure returns (uint256) {
        revert("dead");
    }
}

/// Registry that burns all gas.
contract GasRegistry {
    function register(string calldata) external pure returns (uint256) {
        while (true) {}
        return 0;
    }
}

/// Registry that re-enters createAgent from inside register().
contract ReenteringRegistry is Registry {
    ZeroLuxFactory public factory;
    bool entered;

    function setFactory(ZeroLuxFactory f) external {
        factory = f;
    }

    function register(string calldata) external override returns (uint256 id) {
        if (!entered) {
            entered = true;
            factory.createAgent(address(0xBEEF), 1, 1, bytes32("inner"), "inner", factory.treasury(), factory.markupBps());
        }
        id = next++;
        ownerOf[id] = msg.sender;
        _check(address(0), msg.sender, id);
    }
}

/// Upgraded-to-hostile registry: mints nothing, returns an id that belongs to someone else,
/// and lets transferFrom pass silently.
contract LyingRegistry {
    uint256 public lie;

    function setLie(uint256 id) external {
        lie = id;
    }

    function register(string calldata) external view returns (uint256) {
        return lie;
    }

    function ownerOf(uint256) external pure returns (address) {
        return address(0xdead); // the real owner of that identity
    }

    function transferFrom(address, address, uint256) external {}
}

/// A wallet owner that is also the "token" passed to withdraw, so it can re-enter as the owner.
contract OwnerToken {
    AgentWallet public wallet;
    address public usdg;
    address public sink;
    uint256 public tried;
    uint256 public succeeded;

    function arm(AgentWallet w, address usdg_, address sink_) external {
        wallet = w;
        usdg = usdg_;
        sink = sink_;
    }

    function accept() external {
        wallet.acceptOwnership();
    }

    function go() external {
        wallet.withdraw(address(this), sink, 1);
    }

    function transfer(address, uint256) external returns (bool) {
        // re-entered as the owner, in the middle of withdraw()
        uint256 bal = BlockableUSDG(usdg).balanceOf(address(wallet));
        tried++;
        try wallet.withdraw(usdg, sink, bal) {
            succeeded++;
        } catch {}
        tried++;
        try wallet.endLien() {
            succeeded++;
        } catch {}
        tried++;
        try wallet.setLien(sink, 1, 0) {
            succeeded++;
        } catch {}
        // take exactly what is allowed, then try for one more unit
        wallet.withdraw(usdg, sink, wallet.withdrawable());
        tried++;
        try wallet.withdraw(usdg, sink, 1) {
            succeeded++;
        } catch {}
        return true;
    }
}

contract Review3Test is Test {
    BlockableUSDG usdg;
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
        usdg = new BlockableUSDG();
        factory = new ZeroLuxFactory(address(usdg), admin, operator, treasury, 2_000, address(0));
        (, address w) = factory.createAgent(alice, 1_000e6, 10_000e6, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWallet(w);
    }

    function _earn(uint256 amount) internal {
        usdg.mint(address(wallet), amount);
    }

    function _settle(uint256 settledUpTo) internal {
        vm.prank(operator);
        wallet.settle(settledUpTo);
    }

    function _settleAll() internal {
        _settle(type(uint256).max);
    }

    function _newFactory(address reg) internal returns (ZeroLuxFactory) {
        return new ZeroLuxFactory(address(usdg), admin, operator, treasury, 2_000, reg);
    }

    // =====================================================================
    // ROUND 4: NOTES AND DOCUMENTED BEHAVIOUR (no finding above Note)
    // =====================================================================

    /// Documented (round-3 N1). The baseProfit floor counts unbilled income as settled whenever profit
    /// is at or under the lien's base (after a loss, or the accepted too-high
    /// base). The payee is not overpaid, but the hold on unbilled income is
    /// gone: the owner withdraws it and its run cannot be charged.
    function test_r3_accepted_floor_presettles_unbilled_income_while_profit_is_under_base() public {
        _earn(1_000e6); // pre-lien, $900 of runs not yet billed
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0); // base 1000
        vm.prank(operator);
        wallet.chargeAndSettle("backlog", 750e6, type(uint256).max); // profit 100
        _earn(100e6); // payment for run2, unbilled
        assertEq(wallet.withdrawable(), 100e6, "held, as intended");

        vm.prank(operator);
        wallet.settle(100e6); // the honest figure: only 100 is final
        assertEq(wallet.settledProfit(), 200e6, "floor lifted it over the unbilled payment");
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 200e6);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.chargeAndSettle("run2", 40e6, type(uint256).max);
    }

    /// Accepted as an operating rule (round-2 L1), kept so the rule stays visible:
    /// 24 hours with no settle while unbilled income sits in the wallet lets a
    /// 100% lien sweep it ahead of the run charge.
    function test_r3_accepted_one_quiet_day_reopens_settle_before_billing() public {
        address alt = makeAddr("alice's other address");
        vm.prank(alice);
        wallet.setLien(alt, 10_000, 0);
        _earn(100e6);
        vm.prank(alice);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();
        wallet.settleLien();
        assertEq(usdg.balanceOf(alt), 100e6);
        vm.prank(operator);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.chargeAndSettle("run", 40e6, type(uint256).max);
    }

    // =====================================================================
    // ROUND-2 AND ROUND-3 FINDINGS, NOW CLOSED
    // =====================================================================

    /// Was round-2 L2.
    function test_r3_closed_plain_charge_no_longer_leaves_headroom() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(200e6);
        _settleAll();
        wallet.settleLien();
        vm.prank(operator);
        wallet.charge("run1", 40e6);
        _earn(48e6);
        assertEq(wallet.unsettled(), 48e6);
        assertEq(wallet.withdrawable(), 52e6);
    }

    /// Was round-2 L3.
    function test_r3_closed_payment_racing_a_settle_stays_unsettled() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(100e6); // lands after the operator signed "settled up to 0"
        _settle(0);
        assertEq(wallet.unsettled(), 100e6);
        assertEq(wallet.withdrawable(), 0);
    }

    /// Was round-2 L4.
    function test_r3_closed_frozen_treasury_can_be_replaced_with_the_payees_consent() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(100e6);
        usdg.setBlocked(treasury, true);
        address t2 = makeAddr("treasury2");
        vm.prank(admin);
        factory.proposeTreasury(t2);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptTreasury();

        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NotOwner.selector);
        wallet.consentToTerms(t2, 2_000);
        vm.prank(lender);
        wallet.consentToTerms(t2, 2_000);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienExists.selector);
        wallet.adoptTerms(t2, 2_001);
        vm.prank(alice);
        wallet.adoptTerms(t2, 2_000);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienExists.selector);
        wallet.adoptTerms(t2, 2_000); // consent is used up
        vm.prank(operator);
        wallet.chargeAndSettle("run", 40e6, type(uint256).max);
        assertEq(usdg.balanceOf(t2), 48e6);
    }

    /// Was round-2 N1.
    function test_r3_closed_checkpoint_at_zero_does_not_freeze_pre_lien_money() public {
        _earn(1_000e6);
        vm.prank(alice);
        wallet.setLien(lender, 1, 0);
        _settle(0);
        assertEq(wallet.withdrawable(), 1_000e6);
    }

    // =====================================================================
    // ROUND-1 FINDINGS, NOW CLOSED
    // =====================================================================

    /// Was H1 scenario A. Unsettled income pays the lien nothing; after the
    /// operator bills and settles, the payee gets exactly bps of profit.
    function test_r3_closed_payee_cannot_settle_before_the_run_is_billed() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(100e6);
        vm.prank(lender);
        assertEq(wallet.settleLien(), 0);
        vm.prank(operator);
        wallet.chargeAndSettle("run", 40e6, type(uint256).max); // $48
        wallet.settleLien();
        assertEq(usdg.balanceOf(lender), 26e6);
        assertEq(wallet.withdrawable(), 26e6);
    }

    /// Was H1 scenario B.
    function test_r3_closed_nobody_can_sweep_the_money_ahead_of_the_run_charge() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        _earn(100e6);
        vm.prank(mallory);
        wallet.settleLien();
        wallet.requestCheckpoint(); // a pending request does not help either
        vm.warp(block.timestamp + 23 hours);
        vm.expectRevert(AgentWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
        assertEq(usdg.balanceOf(lender), 0);
        vm.prank(operator);
        wallet.chargeAndSettle("run", 40e6, type(uint256).max);
        assertEq(usdg.balanceOf(treasury), 48e6);
        assertEq(wallet.pendingAt(), 0, "the operator's settle cancelled the request");
        wallet.settleLien();
        assertEq(usdg.balanceOf(lender), 52e6);
    }

    /// Was M1.
    function test_r3_closed_owner_cannot_withdraw_unsettled_income_under_a_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(100e6);
        assertEq(wallet.withdrawable(), 0);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);
        vm.prank(operator);
        wallet.chargeAndSettle("run", 40e6, type(uint256).max);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 26e6);
        wallet.settleLien();
        assertEq(usdg.balanceOf(lender), 26e6);
    }

    /// Was M2, cooperative half: a blocked payee can release, or move the lien.
    function test_r3_closed_blocked_payee_can_release_or_redirect() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(100e6);
        _settleAll();
        usdg.setBlocked(lender, true);

        uint256 snap = vm.snapshotState();
        vm.prank(lender);
        wallet.endLien(); // pure release, no transfer
        assertEq(wallet.withdrawable(), 100e6);
        vm.revertToState(snap);

        vm.prank(lender);
        wallet.setLienPayee(mallory);
        wallet.settleLien();
        assertEq(usdg.balanceOf(mallory), 50e6);
    }

    /// Was M3 (the adoptTerms half; the rest is the documented one-party promise).
    function test_r3_closed_terms_cannot_be_swapped_under_a_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienExists.selector);
        wallet.adoptTerms(treasury, 2_000);
    }

    /// Was L1.
    function test_r3_closed_withdraw_to_self_reverts() public {
        _earn(1e6);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.ZeroAddress.selector);
        wallet.withdraw(address(usdg), address(wallet), 1e6);
        assertEq(wallet.income(), 1e6);
    }

    /// Was L4.
    function test_r3_closed_createAgent_refuses_terms_the_caller_did_not_name() public {
        vm.prank(admin);
        factory.setMarkup(5_000); // front-run
        vm.prank(alice);
        vm.expectRevert(ZeroLuxFactory.TermsChanged.selector);
        factory.createAgent(alice, 1, 1, "s", "", treasury, 2_000);
        vm.prank(alice);
        vm.expectRevert(ZeroLuxFactory.TermsChanged.selector);
        factory.createAgent(alice, 1, 1, "s", "", mallory, 5_000);
    }

    /// Was N1: the add is checked, a 2^128 payment reverts instead of repeating.
    function test_r3_closed_uint128_truncation_reverts() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(uint256(1) << 129);
        _settleAll();
        vm.expectRevert(AgentWallet.BadLien.selector);
        wallet.settleLien();
    }

    /// Was N2: an id the factory does not own is refused.
    function test_r3_closed_lying_registry_is_refused() public {
        LyingRegistry reg = new LyingRegistry();
        ZeroLuxFactory f = _newFactory(address(reg));
        reg.setLie(42);
        vm.prank(mallory);
        vm.expectRevert(ZeroLuxFactory.BadIdentity.selector);
        f.createAgent(mallory, 1, 1, "s", "x", treasury, 2_000);
        assertEq(f.agentCount(), 0);
    }

    // =====================================================================
    // ROUND 4: THE CAPPED EXIT
    // =====================================================================

    /// Note. An operator working with the payee can settle unbilled income, let
    /// the payee collect on it, then bill. The payee is ahead by bps of the run
    /// cost and keeps it by releasing the lien. Bounded by bps of what is in
    /// flight; never past cap; only with a hostile operator.
    function test_r3_note_operator_with_payee_pays_the_share_on_gross() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(100e6);
        _settleAll(); // hostile: the run is not billed yet
        wallet.settleLien();
        vm.prank(operator);
        wallet.chargeAndSettle("run", 40e6, type(uint256).max);
        vm.prank(lender);
        wallet.endLien();
        assertEq(usdg.balanceOf(lender), 50e6, "$26 was the share of real profit");
    }

    /// Was round-3 L2.
    function test_r3_closed_consent_is_cleared_when_the_payee_changes() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(lender);
        wallet.consentToTerms(treasury, 2_000);
        vm.prank(lender);
        wallet.setLienPayee(mallory);
        assertEq(wallet.lienTermsConsent(), bytes32(0));
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienExists.selector);
        wallet.adoptTerms(treasury, 2_000);
    }

    /// Was round-2 M1. The owner's capped exit does not depend on USDG paying the
    /// payee: the last payment is parked, out of the owner's and the meter's
    /// reach, and the payee collects it elsewhere, once. profit() does not move.
    function test_r3_closed_blocked_payee_cannot_block_the_capped_exit_and_parked_money_is_safe() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 50e6);
        _earn(100e6);
        _settleAll();
        usdg.setBlocked(lender, true);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.settleLien();
        uint256 profitBefore = wallet.profit();
        vm.prank(alice);
        wallet.endLien();
        assertEq(wallet.parked(lender), 50e6);
        assertEq(wallet.profit(), profitBefore);
        assertEq(wallet.withdrawable(), 50e6);

        vm.startPrank(alice);
        vm.expectRevert(AgentWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 50e6 + 1);
        wallet.withdraw(address(usdg), alice, 50e6);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(AgentWallet.TransferFailed.selector);
        wallet.charge("r", 1e6);
        vm.prank(mallory);
        vm.expectRevert(AgentWallet.NoLien.selector);
        wallet.claimParked(mallory);
        vm.prank(lender);
        wallet.claimParked(mallory);
        assertEq(usdg.balanceOf(mallory), 50e6);
        assertEq(wallet.parkedTotal(), 0);
        assertEq(wallet.profit(), profitBefore);
        vm.prank(lender);
        vm.expectRevert(AgentWallet.NoLien.selector);
        wallet.claimParked(mallory);
    }

    /// A payee that points the lien at a frozen address does not trap the owner.
    function test_r3_closed_lien_pointed_at_a_frozen_address_does_not_trap_the_owner() public {
        address frozen = makeAddr("frozen");
        usdg.setBlocked(frozen, true);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 50e6);
        _earn(100e6);
        _settleAll();
        vm.prank(lender);
        wallet.setLienPayee(frozen);
        vm.prank(alice);
        wallet.endLien();
        assertEq(wallet.parked(frozen), 50e6);
        _earn(900e6);
        assertEq(wallet.withdrawable(), 950e6);
    }

    /// The owner ends a capped lien only when the payee has had exactly cap:
    /// part payment, a loss, a recovery, and the checkpoint anywhere.
    function test_r3_held_capped_exit_pays_exactly_cap(uint256 settledUpTo, uint256 loss) public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 50e6);
        _earn(60e6);
        _settleAll();
        wallet.settleLien(); // 30 of 50
        loss = bound(loss, 1, 25e6);
        vm.prank(operator);
        wallet.charge("loss", loss); // profit dips after the cap is partly paid
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienStands.selector);
        wallet.endLien();

        _earn(200e6);
        _settle(bound(settledUpTo, 0, 400e6));
        vm.prank(alice);
        try wallet.endLien() {
            assertEq(usdg.balanceOf(lender), 50e6, "ended with the payee short of cap");
            assertEq(wallet.parkedTotal(), 0);
        } catch {
            assertLt(usdg.balanceOf(lender) + wallet.lienUnpaid(), 50e6);
            (address payee,,,,) = wallet.lien();
            assertEq(payee, lender);
        }
    }

    /// Nobody can block the capped exit: dust, unsettled income, a pending
    /// checkpoint and a short wallet (the owner can top it up) all fail.
    function test_r3_held_capped_exit_cannot_be_blocked_by_third_parties() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 50e6);
        _earn(100e6);
        _settleAll(); // accrued = cap
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 50e6);

        usdg.mint(address(wallet), 1); // dust
        _earn(500e6); // a big unsettled payment
        vm.prank(lender);
        wallet.requestCheckpoint(); // pending request
        vm.prank(operator);
        wallet.charge("run", 400e6); // $480 from the wallet: the payee's $50 is still there
        vm.prank(alice);
        wallet.endLien();
        assertEq(usdg.balanceOf(lender), 50e6);
        assertEq(wallet.withdrawable(), usdg.balanceOf(address(wallet)));
    }

    /// Smallest possible cap and share; cap of one unit.
    function test_r3_held_tiny_cap_and_tiny_share() public {
        vm.prank(alice);
        wallet.setLien(lender, 1, 1); // 0.01%, cap $0.000001
        _earn(9_999);
        _settleAll();
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienStands.selector);
        wallet.endLien(); // accrued rounds to 0
        _earn(1);
        _settleAll();
        vm.prank(alice);
        wallet.endLien();
        assertEq(usdg.balanceOf(lender), 1);
    }

    /// The owner cannot force parking by starving the transfer of gas.
    function test_r3_held_owner_cannot_force_parking_with_a_gas_limit() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 50e6);
        _earn(100e6);
        _settleAll();
        for (uint256 g = 30_000; g < 400_000; g += 1_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(alice);
            try wallet.endLien{gas: g}() {
                assertEq(wallet.parkedTotal(), 0);
                assertEq(usdg.balanceOf(lender), 50e6);
            } catch {}
            vm.revertToState(snap);
        }
    }

    /// Documented: with no cap only the payee can end it, whatever has been paid.
    function test_r3_accepted_uncapped_lien_never_ends_without_the_payee() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(1_000_000e6);
        _settleAll();
        wallet.settleLien();
        vm.warp(block.timestamp + 3650 days);
        vm.prank(alice);
        vm.expectRevert(AgentWallet.LienStands.selector);
        wallet.endLien();
    }

    /// Plain wallet, no lien, whatever the checkpoint says: the owner takes
    /// everything at once, charges work, terms can be adopted, and a lien that
    /// came and went leaves nothing behind.
    function test_r3_held_no_lien_wallet_is_unrestricted() public {
        _earn(100e6);
        _settle(0);
        wallet.requestCheckpoint();
        assertEq(wallet.withdrawable(), 100e6);
        vm.prank(operator);
        wallet.chargeAndSettle("r", 10e6, 0);
        vm.prank(alice);
        wallet.adoptTerms(treasury, 2_000);

        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(lender);
        wallet.consentToTerms(mallory, 1);
        vm.prank(lender);
        wallet.endLien();
        assertEq(wallet.lienTermsConsent(), bytes32(0));
        _earn(50e6);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 138e6);
        assertEq(usdg.balanceOf(address(wallet)), 0);
        vm.prank(alice);
        wallet.adoptTerms(treasury, 2_000);
    }

    // =====================================================================
    // HELD UP
    // =====================================================================

    /// A wallet owner that is also the token passed to withdraw re-enters as the
    /// owner mid-call and still cannot take the pledged share, end or reset the lien.
    function test_r3_held_owner_reentrancy_through_its_own_token_cannot_beat_the_lien() public {
        OwnerToken ot = new OwnerToken();
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(100e6);
        _settleAll();
        vm.prank(alice);
        wallet.transferOwnership(address(ot));
        ot.arm(wallet, address(usdg), mallory);
        ot.accept();
        ot.go();
        assertEq(ot.tried(), 4);
        assertEq(ot.succeeded(), 0);
        assertEq(usdg.balanceOf(mallory), 50e6);
        assertEq(wallet.lienUnpaid(), 50e6);
        assertEq(usdg.balanceOf(address(wallet)), 50e6);
    }

    /// Someone parks a worthless request so a useful one cannot be made. The
    /// cost is one extra day, not a lock.
    function test_r3_held_pending_request_griefing_costs_one_extra_day_at_most() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(mallory);
        wallet.requestCheckpoint(); // at profit 0
        _earn(100e6);
        vm.prank(lender);
        vm.expectRevert(AgentWallet.CheckpointPending.selector);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 0);
        vm.prank(lender);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();
        wallet.settleLien();
        assertEq(usdg.balanceOf(lender), 50e6);
    }

    /// Pumping profit for the request and a stale request taken much later both
    /// fail: the checkpoint is min(recorded, current) and never moves down.
    function test_r3_held_request_cannot_be_pumped_or_aged_into_a_bad_checkpoint() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _earn(100e6);
        wallet.requestCheckpoint(); // records 100
        vm.prank(operator);
        wallet.charge("run", 40e6); // plain charge: request stays, profit 52
        vm.warp(block.timestamp + 90 days);
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 52e6);
        wallet.settleLien();
        assertEq(usdg.balanceOf(lender), 26e6);
    }

    /// A dead or gas-burning registry blocks only callers who ask for an identity.
    function test_r3_held_broken_registry_cannot_block_creation_with_empty_uri() public {
        ZeroLuxFactory f = _newFactory(address(new DeadRegistry()));
        vm.expectRevert();
        f.createAgent(alice, 1, 1, "s", "uri", treasury, 2_000);
        (uint256 id, address w) = f.createAgent(alice, 1, 1, "s", "", treasury, 2_000);
        assertEq(f.agent(id).wallet, w);
        assertFalse(f.agent(id).hasIdentity);

        ZeroLuxFactory g = _newFactory(address(new GasRegistry()));
        (, address w2) = g.createAgent{gas: 400_000}(alice, 1, 1, "s", "", treasury, 2_000);
        assertTrue(g.isAgentWallet(w2));
    }

    /// A registry that re-enters createAgent from register() only reverts itself.
    function test_r3_held_reentering_registry_only_reverts_itself() public {
        ReenteringRegistry reg = new ReenteringRegistry();
        ZeroLuxFactory f = _newFactory(address(reg));
        reg.setFactory(f);
        vm.prank(alice);
        vm.expectRevert();
        f.createAgent(alice, 1, 1, "s", "outer", treasury, 2_000);
        assertEq(f.agentCount(), 0);
    }

    /// Honest registry: the identity ends with the agent owner, never the factory.
    function test_r3_held_identity_goes_to_the_agent_owner() public {
        Registry reg = new Registry();
        ZeroLuxFactory f = _newFactory(address(reg));
        vm.prank(mallory);
        (uint256 id,) = f.createAgent(alice, 1, 1, "s", "uri", treasury, 2_000);
        assertEq(reg.ownerOf(f.agent(id).identityId), alice);
    }

    /// Random orderings of earn / charge / chargeAndSettle / settle / request /
    /// take / withdraw / settleLien / owner endLien, with an operator that may
    /// pass ANY unbilledIncome. The payee is never paid more than bps of the
    /// highest profit the wallet ever showed, never more than cap; the owner
    /// never withdraws past withdrawable(); an uncapped lien never ends and a
    /// capped one ends only with exactly cap paid; nothing reverts unexpectedly.
    function testFuzz_r3_held_lien_books(uint16 bps, uint128 cap, uint256 seed) public {
        bps = uint16(bound(bps, 1, 10_000));
        cap = uint128(bound(cap, 0, 5_000e6));
        vm.prank(alice);
        wallet.setLimits(type(uint128).max, type(uint128).max);
        _earn(bound(seed, 0, 500e6)); // pre-lien money
        vm.prank(alice);
        wallet.setLien(lender, bps, cap);
        uint256 base = wallet.profit();
        uint256 peak = base;

        for (uint256 i = 0; i < 32; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = seed % 9;
            uint256 x = (seed >> 8) % 400e6;
            uint256 bal = usdg.balanceOf(address(wallet));
            if (op == 0) {
                _earn(x);
            } else if (op == 1) {
                if (x != 0 && x + x / 5 <= bal) {
                    vm.prank(operator);
                    wallet.charge(bytes32(i + 1), x);
                }
            } else if (op == 2) {
                if (x != 0 && x + x / 5 <= bal) {
                    vm.prank(operator);
                    wallet.chargeAndSettle(bytes32(i + 1), x, (seed >> 40) % 300e6);
                }
            } else if (op == 3) {
                _settle((seed >> 40) % 300e6);
            } else if (op == 4) {
                uint256 w = wallet.withdrawable();
                vm.startPrank(alice);
                if (w != 0) wallet.withdraw(address(usdg), alice, x % (w + 1));
                uint256 over = wallet.withdrawable() + 1;
                vm.expectRevert(AgentWallet.LienOwed.selector);
                wallet.withdraw(address(usdg), alice, over);
                vm.stopPrank();
            } else if (op == 5) {
                wallet.settleLien();
            } else if (op == 6) {
                if (wallet.pendingAt() == 0) wallet.requestCheckpoint();
            } else if (op == 7) {
                vm.warp(block.timestamp + 13 hours);
                if (wallet.pendingAt() != 0 && block.timestamp >= wallet.pendingAt() + 1 days) wallet.takeCheckpoint();
            } else if (cap == 0) {
                vm.prank(alice);
                vm.expectRevert(AgentWallet.LienStands.selector);
                wallet.endLien();
            } else {
                vm.prank(alice);
                try wallet.endLien() {
                    assertEq(usdg.balanceOf(lender), cap, "capped exit paid something other than cap");
                    assertEq(wallet.withdrawable(), usdg.balanceOf(address(wallet)));
                    return;
                } catch {}
            }
            uint256 p = wallet.profit();
            if (p > peak) peak = p;
            bal = usdg.balanceOf(address(wallet));
            assertLe(wallet.withdrawable(), bal);
            assertLe(usdg.balanceOf(lender) * 10_000, (peak - base) * bps);
            if (cap != 0) assertLe(usdg.balanceOf(lender), cap);
        }
        (,,, uint128 paid,) = wallet.lien();
        if (cap == 0) assertEq(paid, usdg.balanceOf(lender));
    }
}
