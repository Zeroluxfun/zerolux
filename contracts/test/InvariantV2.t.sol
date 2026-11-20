// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {ZeroLuxFactoryV2} from "../src/ZeroLuxFactoryV2.sol";
import {AgentWalletV2} from "../src/AgentWalletV2.sol";
import {MockUSDG3009} from "./V2.t.sol";

/// Drives one AgentWalletV2 with bounded random actions and keeps its own books.
///
/// Two modes:
///  - strict: the meter behaves as the wallet's own comments say it should. Every
///    hold is covered by a payment that arrives in the same action, and the
///    checkpoint is only ever moved to "profit less money still held".
///  - loose (strict = false): the meter may do anything the contract lets it:
///    open holds against money that was already in the wallet, move the checkpoint
///    to any figure, and anyone may request and take a checkpoint.
///
/// No action reverts: each one either goes through or returns early and is counted
/// as skipped, so the test contracts can run with fail-on-revert switched on.
contract WalletHandler is Test {
    AgentWalletV2 public wallet;
    MockUSDG3009 public usdg;
    address public operator;
    address public owner;
    address public treasury;
    bool public strict;

    address internal customer = makeAddr("inv-customer");
    address internal stranger = makeAddr("inv-stranger");
    address[3] internal payees;

    // ---- ghost books ----
    uint256 public ghostPaidIn; // every USDG that reached the wallet
    uint256 public ghostCharged; // every USDG charged, fee included
    uint256 public ghostLienPaid; // every USDG sent to a lien payee
    uint256 public ghostWithdrawn; // every USDG the owner took out
    uint256 public ghostHeld; // sum of holds the handler believes are open

    bytes32[] public openRuns;
    mapping(bytes32 => uint256) internal openIndex; // 1-based
    bytes32[] public chargedRuns;
    mapping(bytes32 => uint256) public budgetOf;
    mapping(bytes32 => uint256) public holdOpened; // the hold as opened, fee included
    mapping(bytes32 => uint256) public chargedFor; // total charged for the run, fee included
    mapping(bytes32 => uint256) public chargeCount;

    uint256 public lienCapNow; // cap of the lien that stands (0 = none)
    uint256 public lienPaidNow; // paid to the lien that stands
    uint256 public liensSet;
    uint256 public capsReached; // times a lien was paid right up to its cap

    // ---- things that must never happen; each is asserted false by the test ----
    bool public chargedTwice; // a second charge or a re-open of a charged run went through
    bool public chargedOverHold; // a run was charged more than its hold
    bool public lienPaidOverCap; // a lien paid more than its cap
    bool public withdrewOwedMoney; // after a withdrawal the wallet held less than holds + lien owed
    bool public withdrewOverLimit; // a withdrawal above withdrawable() went through
    bool public strangerReleasedEarly; // a non-operator released a hold under a day old
    string public lastBreach;

    uint256 internal seq;

    // ---- call counters ----
    string[] public actions;
    mapping(string => uint256) public done;
    mapping(string => uint256) public skipped;

    constructor(AgentWalletV2 wallet_, MockUSDG3009 usdg_, address operator_, address owner_, bool strict_) {
        wallet = wallet_;
        usdg = usdg_;
        operator = operator_;
        owner = owner_;
        treasury = wallet_.treasury();
        strict = strict_;
        payees[0] = makeAddr("inv-payee-0");
        payees[1] = makeAddr("inv-payee-1");
        payees[2] = makeAddr("inv-payee-2");
        string[18] memory names = [
            "payAndOpen",
            "fundAndOpen",
            "charge",
            "chargeAndSettle",
            "rechargeProbe",
            "release",
            "withdraw",
            "setLien",
            "settleLien",
            "endLienPayee",
            "endLienOwner",
            "warp",
            "settle",
            "setPaused",
            "setLimits",
            "openFromBalance",
            "requestCheckpoint",
            "takeCheckpoint"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            actions.push(names[i]);
        }
    }

    function actionCount() external view returns (uint256) {
        return actions.length;
    }

    function openRunCount() external view returns (uint256) {
        return openRuns.length;
    }

    function chargedRunCount() external view returns (uint256) {
        return chargedRuns.length;
    }

    // ---- helpers ----

    function _bal() internal view returns (uint256) {
        return usdg.balanceOf(address(wallet));
    }

    function _lienPayee() internal view returns (address payee) {
        (payee,,,,) = wallet.lien();
    }

    function _breach(string memory what) internal {
        lastBreach = what;
    }

    function _newRun() internal returns (bytes32) {
        return keccak256(abi.encode("run", ++seq));
    }

    /// The largest budget the wallet would let in right now, fee included in the limits.
    function _maxBudget() internal view returns (uint256) {
        uint256 room = wallet.perRunCap();
        uint256 today = wallet.remainingToday();
        if (today < room) room = today;
        return (room * 10_000) / (10_000 + wallet.markupBps());
    }

    function _total(uint256 budget) internal view returns (uint256) {
        return budget + (budget * wallet.markupBps()) / 10_000;
    }

    function _recordOpen(bytes32 run, uint256 budget, uint256 total) internal {
        (uint128 held,,) = wallet.holds(run);
        assertEq(held, total, "hold opened for the wrong amount");
        budgetOf[run] = budget;
        holdOpened[run] = total;
        ghostHeld += total;
        openRuns.push(run);
        openIndex[run] = openRuns.length;
    }

    function _forgetOpen(bytes32 run) internal {
        uint256 i = openIndex[run];
        bytes32 last = openRuns[openRuns.length - 1];
        openRuns[i - 1] = last;
        openIndex[last] = i;
        openRuns.pop();
        openIndex[run] = 0;
        ghostHeld -= holdOpened[run];
    }

    // ---- money in, hold opened ----

    /// A customer's signed payment arrives through `pay` and the hold opens with it.
    /// strict: the payment covers the whole hold. loose: it may be smaller, the
    /// rest coming from money that was already free in the wallet.
    function payAndOpen(uint256 budgetSeed, uint256 valueSeed) external {
        uint256 maxBudget = _maxBudget();
        if (wallet.paused() || maxBudget == 0) {
            skipped["payAndOpen"]++;
            return;
        }
        uint256 budget = bound(budgetSeed, 1, maxBudget > 50e6 ? 50e6 : maxBudget);
        uint256 total = _total(budget);
        uint256 value;
        if (strict) {
            value = total + bound(valueSeed, 0, 20e6);
        } else {
            value = bound(valueSeed, 1, total + 20e6);
            uint256 spoken = wallet.parkedTotal() + wallet.heldTotal() + total;
            if (_bal() + value < spoken) value = spoken - _bal();
        }
        bytes32 run = _newRun();
        usdg.mint(customer, value);
        vm.prank(operator);
        wallet.pay(customer, value, 0, block.timestamp + 600, run, 27, bytes32(0), bytes32(0), run, budget);
        ghostPaidIn += value;
        _recordOpen(run, budget, total);
        done["payAndOpen"]++;
    }

    /// The payment arrives some other way (a plain transfer), then the meter opens
    /// the hold with `open`. The transfer covers the whole hold.
    function fundAndOpen(uint256 budgetSeed, uint256 extraSeed) external {
        uint256 maxBudget = _maxBudget();
        if (wallet.paused() || maxBudget == 0) {
            skipped["fundAndOpen"]++;
            return;
        }
        uint256 budget = bound(budgetSeed, 1, maxBudget > 50e6 ? 50e6 : maxBudget);
        uint256 total = _total(budget);
        uint256 value = total + bound(extraSeed, 0, 20e6);
        bytes32 run = _newRun();
        usdg.mint(address(wallet), value);
        ghostPaidIn += value;
        vm.prank(operator);
        wallet.open(run, budget);
        _recordOpen(run, budget, total);
        done["fundAndOpen"]++;
    }

    /// Loose mode only: a hold opened against whatever is free in the wallet, with
    /// no new money. Everything `open` itself allows.
    function openFromBalance(uint256 budgetSeed) external {
        uint256 maxBudget = _maxBudget();
        uint256 spoken = wallet.parkedTotal() + wallet.heldTotal();
        uint256 free = _bal() > spoken ? _bal() - spoken : 0;
        uint256 freeBudget = (free * 10_000) / (10_000 + wallet.markupBps());
        if (freeBudget < maxBudget) maxBudget = freeBudget;
        if (wallet.paused() || maxBudget == 0) {
            skipped["openFromBalance"]++;
            return;
        }
        uint256 budget = bound(budgetSeed, 1, maxBudget);
        bytes32 run = _newRun();
        vm.prank(operator);
        wallet.open(run, budget);
        _recordOpen(run, budget, _total(budget));
        done["openFromBalance"]++;
    }

    // ---- charge ----

    function charge(uint256 runSeed, uint256 costSeed) external {
        if (openRuns.length == 0) {
            skipped["charge"]++;
            return;
        }
        bytes32 run = openRuns[runSeed % openRuns.length];
        uint256 cost = bound(costSeed, 1, budgetOf[run]);
        uint256 before = usdg.balanceOf(treasury);
        vm.prank(operator);
        wallet.charge(run, cost);
        _recordCharge(run, usdg.balanceOf(treasury) - before);
        done["charge"]++;
    }

    /// Charge and move the checkpoint. strict: to profit after the charge less what
    /// is still held, as the contract's comments tell the meter to. loose: half the
    /// time to any figure at all.
    function chargeAndSettle(uint256 runSeed, uint256 costSeed, uint256 settleSeed) external {
        if (openRuns.length == 0) {
            skipped["chargeAndSettle"]++;
            return;
        }
        bytes32 run = openRuns[runSeed % openRuns.length];
        uint256 cost = bound(costSeed, 1, budgetOf[run]);
        uint256 profitAfter = wallet.profit() - _total(cost);
        uint256 heldAfter = wallet.heldTotal() - holdOpened[run];
        uint256 upTo = profitAfter > heldAfter ? profitAfter - heldAfter : 0;
        if (!strict && settleSeed % 2 == 1) upTo = bound(settleSeed, 0, profitAfter * 2 + 1);
        uint256 before = usdg.balanceOf(treasury);
        vm.prank(operator);
        wallet.chargeAndSettle(run, cost, upTo);
        _recordCharge(run, usdg.balanceOf(treasury) - before);
        done["chargeAndSettle"]++;
    }

    function _recordCharge(bytes32 run, uint256 total) internal {
        _forgetOpen(run);
        chargeCount[run]++;
        chargedFor[run] += total;
        ghostCharged += total;
        if (chargeCount[run] == 1) chargedRuns.push(run);
        if (chargeCount[run] > 1) {
            chargedTwice = true;
            _breach("run charged twice");
        }
        if (chargedFor[run] > holdOpened[run]) {
            chargedOverHold = true;
            _breach("run charged over its hold");
        }
    }

    /// A run that was charged must refuse a second charge, a re-open and a release.
    function rechargeProbe(uint256 runSeed, uint256 costSeed) external {
        if (chargedRuns.length == 0) {
            skipped["rechargeProbe"]++;
            return;
        }
        bytes32 run = chargedRuns[runSeed % chargedRuns.length];
        uint256 cost = bound(costSeed, 1, budgetOf[run]);
        // Make sure a lack of money is never the reason the wallet says no.
        usdg.mint(address(wallet), holdOpened[run]);
        ghostPaidIn += holdOpened[run];

        vm.startPrank(operator);
        try wallet.charge(run, cost) {
            chargedTwice = true;
            _breach("second charge went through");
        } catch {}
        try wallet.open(run, cost) {
            chargedTwice = true;
            _breach("charged run was opened again");
        } catch {}
        try wallet.release(run) {
            chargedTwice = true;
            _breach("charged run was released");
        } catch {}
        vm.stopPrank();
        done["rechargeProbe"]++;
    }

    // ---- release ----

    function release(uint256 runSeed, bool byStranger) external {
        if (openRuns.length == 0) {
            skipped["release"]++;
            return;
        }
        bytes32 run = openRuns[runSeed % openRuns.length];
        (,, uint64 openedAt) = wallet.holds(run);
        address who = operator;
        if (byStranger) {
            if (block.timestamp >= uint256(openedAt) + wallet.HOLD_TIMEOUT()) {
                who = stranger;
            } else {
                vm.prank(stranger);
                try wallet.release(run) {
                    strangerReleasedEarly = true;
                    _breach("stranger released a young hold");
                    _forgetOpen(run);
                    return;
                } catch {}
            }
        }
        vm.prank(who);
        wallet.release(run);
        _forgetOpen(run);
        done["release"]++;
    }

    // ---- owner ----

    function withdraw(uint256 amountSeed) external {
        uint256 limit = wallet.withdrawable();

        // One more than the limit must always be refused.
        vm.prank(owner);
        try wallet.withdraw(address(usdg), owner, limit + 1) {
            withdrewOverLimit = true;
            _breach("withdrew more than withdrawable()");
            ghostWithdrawn += limit + 1;
            return;
        } catch {}

        if (limit == 0) {
            skipped["withdraw"]++;
            return;
        }
        uint256 amount = bound(amountSeed, 1, limit);
        vm.prank(owner);
        wallet.withdraw(address(usdg), owner, amount);
        ghostWithdrawn += amount;
        if (_bal() < wallet.heldTotal() + wallet.parkedTotal() + wallet.lienUnpaid()) {
            withdrewOwedMoney = true;
            _breach("withdrawal left less than holds + lien owed");
        }
        done["withdraw"]++;
    }

    function setLien(uint256 payeeSeed, uint16 bpsSeed, uint128 capSeed) external {
        if (_lienPayee() != address(0)) {
            skipped["setLien"]++;
            return;
        }
        uint16 bps = uint16(bound(bpsSeed, 1, 10_000));
        // No cap a quarter of the time; otherwise a cap, half of them small enough to be reached.
        uint128 cap = capSeed % 4 == 0 ? 0 : uint128(bound(capSeed, 1, capSeed % 4 == 1 ? 100e6 : 3e6));
        vm.prank(owner);
        wallet.setLien(payees[payeeSeed % 3], bps, cap);
        lienCapNow = cap;
        lienPaidNow = 0;
        liensSet++;
        done["setLien"]++;
    }

    function setPaused(uint256 seed) external {
        vm.prank(owner);
        wallet.setPaused(seed % 4 == 0);
        done["setPaused"]++;
    }

    function setLimits(uint128 runSeed, uint128 daySeed) external {
        vm.prank(owner);
        wallet.setLimits(uint128(bound(runSeed, 1e6, 100e6)), uint128(bound(daySeed, 10e6, 1_000e6)));
        done["setLimits"]++;
    }

    // ---- lien ----

    function settleLien() external {
        address payee = _lienPayee();
        if (payee == address(0)) {
            skipped["settleLien"]++;
            return;
        }
        uint256 before = usdg.balanceOf(payee);
        vm.prank(stranger);
        uint256 amount = wallet.settleLien();
        assertEq(usdg.balanceOf(payee) - before, amount, "settleLien returned a different amount than it sent");
        _recordLienPaid(amount);
        done["settleLien"]++;
    }

    function _recordLienPaid(uint256 amount) internal {
        ghostLienPaid += amount;
        lienPaidNow += amount;
        if (amount != 0 && lienCapNow != 0 && lienPaidNow == lienCapNow) capsReached++;
        if (lienCapNow != 0 && lienPaidNow > lienCapNow) {
            lienPaidOverCap = true;
            _breach("lien paid over its cap");
        }
    }

    function endLienByPayee() external {
        address payee = _lienPayee();
        if (payee == address(0)) {
            skipped["endLienPayee"]++;
            return;
        }
        vm.prank(payee);
        wallet.endLien();
        lienCapNow = 0;
        lienPaidNow = 0;
        done["endLienPayee"]++;
    }

    /// The owner may end a lien only once it has paid its cap; otherwise the wallet says no.
    function endLienByOwner() external {
        address payee = _lienPayee();
        if (payee == address(0)) {
            skipped["endLienOwner"]++;
            return;
        }
        (,, uint128 cap, uint128 paidBefore,) = wallet.lien();
        uint256 owed = wallet.lienUnpaid();
        uint256 before = usdg.balanceOf(payee);
        vm.prank(owner);
        try wallet.endLien() {
            assertTrue(cap != 0 && uint256(paidBefore) + owed >= cap, "owner ended a lien that had not paid its cap");
            _recordLienPaid(usdg.balanceOf(payee) - before);
            lienCapNow = 0;
            lienPaidNow = 0;
            done["endLienOwner"]++;
        } catch {
            skipped["endLienOwner"]++;
        }
    }

    // ---- checkpoint and time ----

    /// Move the checkpoint without a charge. strict: to profit less what is held.
    function settle(uint256 seed) external {
        uint256 p = wallet.profit();
        uint256 held = wallet.heldTotal();
        uint256 upTo = p > held ? p - held : 0;
        if (!strict && seed % 2 == 1) upTo = bound(seed, 0, p * 2 + 1);
        vm.prank(operator);
        wallet.settle(upTo);
        done["settle"]++;
    }

    function requestCheckpoint() external {
        if (wallet.pendingAt() != 0) {
            skipped["requestCheckpoint"]++;
            return;
        }
        vm.prank(stranger);
        wallet.requestCheckpoint();
        done["requestCheckpoint"]++;
    }

    function takeCheckpoint() external {
        uint256 at = wallet.pendingAt();
        if (at == 0 || block.timestamp < at + wallet.CHECKPOINT_DELAY()) {
            skipped["takeCheckpoint"]++;
            return;
        }
        vm.prank(stranger);
        wallet.takeCheckpoint();
        done["takeCheckpoint"]++;
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 10 minutes, 36 hours));
        done["warp"]++;
    }
}

/// The six properties, checked after every handler call.
abstract contract WalletInvariants is Test {
    MockUSDG3009 usdg;
    ZeroLuxFactoryV2 factory;
    AgentWalletV2 wallet;
    WalletHandler handler;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    function _deploy(bool strict) internal {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG3009();
        factory = new ZeroLuxFactoryV2(address(usdg), admin, operator, treasury, 2_000, address(0));
        (, address w) = factory.createAgent(alice, 100e6, 1_000e6, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWalletV2(w);
        handler = new WalletHandler(wallet, usdg, operator, alice, strict);
        targetContract(address(handler));
    }

    function _bal() internal view returns (uint256) {
        return usdg.balanceOf(address(wallet));
    }

    // 1. Money set aside for open runs is always in the wallet.
    function _holdsAreBacked() internal view {
        assertGe(_bal(), wallet.heldTotal(), "balance < heldTotal");
        assertEq(wallet.heldTotal(), handler.ghostHeld(), "heldTotal != sum of open holds");
    }

    // 2. ... and so is what the lien payee is still owed (and anything parked for a payee).
    function _holdsAndLienAreBacked() internal view {
        assertGe(
            _bal(),
            wallet.heldTotal() + wallet.parkedTotal() + wallet.lienUnpaid(),
            "balance < heldTotal + parkedTotal + lienUnpaid"
        );
    }

    // 2 (owner's side). No withdrawal ever left the wallet short of holds + lien owed,
    // and no withdrawal above withdrawable() ever went through.
    function _ownerNeverTookOwedMoney() internal view {
        assertFalse(handler.withdrewOwedMoney(), "a withdrawal left less than holds + lien owed");
        assertFalse(handler.withdrewOverLimit(), "a withdrawal above withdrawable() went through");
    }

    // 3. The owner's limit never reaches into held money.
    function _withdrawableIsFree() internal view {
        uint256 bal = _bal();
        uint256 held = wallet.heldTotal();
        assertLe(wallet.withdrawable(), bal > held ? bal - held : 0, "withdrawable > balance - heldTotal");
    }

    // 4. One charge per run, never more than its hold.
    function _runsChargedOnce() internal view {
        assertFalse(handler.chargedTwice(), handler.lastBreach());
        assertFalse(handler.chargedOverHold(), "a run was charged over its hold");
        assertFalse(handler.strangerReleasedEarly(), "a stranger released a young hold");
        uint256 n = handler.chargedRunCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 run = handler.chargedRuns(i);
            assertEq(handler.chargeCount(run), 1, "run charged more than once");
            assertLe(handler.chargedFor(run), handler.holdOpened(run), "run charged over its hold");
            assertTrue(wallet.runCharged(run), "charged run not marked");
            (uint128 held,,) = wallet.holds(run);
            assertEq(held, 0, "charged run still has a hold");
        }
    }

    // 5. The books. profit() is income() - totalCharged() by definition in the contract.
    function _booksAgree() internal view {
        assertEq(wallet.income(), handler.ghostPaidIn(), "income != paid in");
        assertEq(wallet.totalCharged(), handler.ghostCharged(), "totalCharged != charges made");
        assertEq(wallet.profit(), wallet.income() - wallet.totalCharged(), "profit != income - totalCharged");
        assertEq(usdg.balanceOf(treasury), handler.ghostCharged(), "treasury did not receive exactly the charges");
        assertEq(
            _bal(),
            handler.ghostPaidIn() - handler.ghostCharged() - handler.ghostWithdrawn() - handler.ghostLienPaid(),
            "balance != in - charged - withdrawn - lien paid"
        );
        assertEq(
            wallet.totalOut(),
            handler.ghostCharged() + handler.ghostWithdrawn() + handler.ghostLienPaid(),
            "totalOut != charged + withdrawn + lien paid"
        );
    }

    // 6. A lien never pays more than its cap.
    function _lienWithinCap() internal view {
        assertFalse(handler.lienPaidOverCap(), "a lien paid over its cap");
        (address payee,, uint128 cap, uint128 paid,) = wallet.lien();
        if (payee != address(0)) {
            assertEq(paid, handler.lienPaidNow(), "lien.paid != what the payee received");
            if (cap != 0) assertLe(paid, cap, "lien.paid > cap");
        }
    }

    /// Set INV_SUMMARY=true to print, under the last run's logs (-vv), running totals
    /// over every run so far: calls of each kind that went through, and calls skipped
    /// because there was nothing to act on. Totals are carried between runs in
    /// process environment variables; without INV_SUMMARY this does nothing.
    function afterInvariant() public {
        if (!vm.envOr("INV_SUMMARY", false)) return;
        string memory mode = handler.strict() ? "strict " : "loose ";
        uint256 n = handler.actionCount();
        for (uint256 i = 0; i < n; i++) {
            string memory a = handler.actions(i);
            console.log(
                string.concat("SUMMARY ", mode, a), _tally(a, "_done", handler.done(a)), _tally(a, "_skip", handler.skipped(a))
            );
        }
        console.log(string.concat("SUMMARY ", mode, "liensSet"), _tally("liensSet", "", handler.liensSet()));
        console.log(string.concat("SUMMARY ", mode, "lienPaidUSDG"), _tally("lienPaid", "", handler.ghostLienPaid()));
        console.log(string.concat("SUMMARY ", mode, "capsReached"), _tally("capsReached", "", handler.capsReached()));
    }

    function _tally(string memory name, string memory kind, uint256 add) private returns (uint256 total) {
        string memory key = string.concat("INV_TALLY_", handler.strict() ? "S_" : "L_", name, kind);
        total = vm.envOr(key, uint256(0)) + add;
        vm.setEnv(key, vm.toString(total));
    }
}

/// The meter behaves as documented: every hold is covered by its own payment and
/// the checkpoint only moves to profit less held money.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 150
/// forge-config: default.invariant.fail-on-revert = true
contract InvariantV2Test is WalletInvariants {
    function setUp() public {
        _deploy(true);
        bytes4[] memory s = new bytes4[](14);
        s[0] = WalletHandler.payAndOpen.selector;
        s[1] = WalletHandler.fundAndOpen.selector;
        s[2] = WalletHandler.charge.selector;
        s[3] = WalletHandler.chargeAndSettle.selector;
        s[4] = WalletHandler.rechargeProbe.selector;
        s[5] = WalletHandler.release.selector;
        s[6] = WalletHandler.withdraw.selector;
        s[7] = WalletHandler.setLien.selector;
        s[8] = WalletHandler.settleLien.selector;
        s[9] = WalletHandler.endLienByPayee.selector;
        s[10] = WalletHandler.endLienByOwner.selector;
        s[11] = WalletHandler.warp.selector;
        s[12] = WalletHandler.settle.selector;
        s[13] = WalletHandler.setLimits.selector;
        targetSelector(FuzzSelector(address(handler), s));
    }

    function invariant_1_balance_covers_holds() public view {
        _holdsAreBacked();
    }

    function invariant_2_balance_covers_holds_and_lien_owed() public view {
        _holdsAndLienAreBacked();
        _ownerNeverTookOwedMoney();
    }

    function invariant_3_withdrawable_never_reaches_held_money() public view {
        _withdrawableIsFree();
    }

    function invariant_4_a_run_is_charged_once_and_within_its_hold() public view {
        _runsChargedOnce();
    }

    function invariant_5_books_agree() public view {
        _booksAgree();
    }

    function invariant_6_lien_never_pays_over_its_cap() public view {
        _lienWithinCap();
    }
}

/// The meter and the owner do anything the contract allows: holds opened against
/// money already in the wallet, the checkpoint moved to any figure, checkpoints
/// requested and taken by anyone, pausing. Every property is checked here too,
/// except the whole-wallet form of property 2 (see the note on it below); its
/// owner-side form (2b) is checked.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 150
/// forge-config: default.invariant.fail-on-revert = true
contract InvariantV2LooseTest is WalletInvariants {
    function setUp() public {
        _deploy(false);
    }

    function invariant_1_balance_covers_holds() public view {
        _holdsAreBacked();
    }

    // Property 2 as a whole-wallet statement (balance >= heldTotal + parkedTotal +
    // lienUnpaid) does NOT hold in this mode: the fuzzer breaks it in three ways,
    // none of them an owner withdrawal. Each is pinned as a plain test in
    // InvariantV2FindingsTest below. To see the fuzzer find them, run with
    // INV_LOOSE_PROPERTY_2=true.
    function invariant_2_balance_covers_holds_and_lien_owed() public view {
        if (vm.envOr("INV_LOOSE_PROPERTY_2", false)) _holdsAndLienAreBacked();
    }

    function invariant_2b_owner_never_withdraws_held_or_owed_money() public view {
        _ownerNeverTookOwedMoney();
    }

    function invariant_3_withdrawable_never_reaches_held_money() public view {
        _withdrawableIsFree();
    }

    function invariant_4_a_run_is_charged_once_and_within_its_hold() public view {
        _runsChargedOnce();
    }

    function invariant_5_books_agree() public view {
        _booksAgree();
    }

    function invariant_6_lien_never_pays_over_its_cap() public view {
        _lienWithinCap();
    }
}

/// What the loose run found, as fixed sequences. Each test passes while the wallet
/// behaves as it does today and shows by how much "balance >= heldTotal +
/// lienUnpaid" is missed. None of them is an owner withdrawal of held or owed
/// money: in all three the meter (or, for the third, anyone after a day) is the
/// one that moves. If the contract is changed to close one of these, its test
/// will fail and should be turned into an assertion of the new behaviour.
contract InvariantV2FindingsTest is Test {
    MockUSDG3009 usdg;
    ZeroLuxFactoryV2 factory;
    AgentWalletV2 wallet;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address lender = makeAddr("lender");
    address customer = makeAddr("customer");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG3009();
        factory = new ZeroLuxFactoryV2(address(usdg), admin, operator, treasury, 2_000, address(0));
        (, address w) = factory.createAgent(alice, 100e6, 1_000e6, keccak256("spec"), "", treasury, 2_000);
        wallet = AgentWalletV2(w);
        usdg.mint(customer, 100e6);
    }

    function _bal() internal view returns (uint256) {
        return usdg.balanceOf(address(wallet));
    }

    /// `open` checks that the money is not held or parked, but not that it is owed
    /// to the lien. A hold can be opened on the payee's unpaid share, and charging
    /// it leaves the payee owed money the wallet no longer has.
    function test_finding_a_hold_can_be_opened_on_money_owed_to_the_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0); // half of profit

        usdg.mint(address(wallet), 1e6); // $1 of income, no run attached
        vm.prank(operator);
        wallet.settle(1e6); // nothing is held, so all of it is final
        assertEq(wallet.lienUnpaid(), 500_000);

        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 500_000); // the owner's half; allowed
        assertEq(wallet.withdrawable(), 0);
        assertEq(_bal(), 500_000, "all that is left is the lender's half");

        vm.prank(operator);
        wallet.open("r1", 400_000); // $0.48 with the fee, set aside out of the lender's half
        assertLt(_bal(), wallet.heldTotal() + wallet.lienUnpaid(), "property 2 is broken here");
        assertEq(wallet.heldTotal() + wallet.lienUnpaid() - _bal(), 480_000);

        // While the hold stands the lender can collect only what is outside it.
        assertEq(wallet.settleLien(), 20_000);

        // The run is billed in full. Profit is now $0.52; half is $0.26; $0.02 was paid.
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 400_000, 520_000);
        assertEq(wallet.profit(), 520_000);
        assertEq(wallet.lienUnpaid(), 240_000, "the lender is still owed $0.24");
        assertEq(_bal(), 0, "and the wallet is empty");
        assertEq(usdg.balanceOf(alice), 500_000, "the owner kept $0.50 of a $0.52 profit");
        assertEq(usdg.balanceOf(lender), 20_000, "the lender has $0.02 of its $0.26");
    }

    /// Nothing stops the meter moving the checkpoint over money that is still held
    /// for an unbilled run. The lien is then owed a share of money that is set aside.
    function test_finding_the_meter_can_settle_over_money_still_held() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0); // all of profit

        vm.prank(operator);
        wallet.pay(customer, 600_000, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 500_000);
        assertEq(wallet.heldTotal(), 600_000);

        vm.prank(operator);
        wallet.settle(600_000); // should have been profit less held = 0
        assertEq(wallet.lienUnpaid(), 600_000);
        assertLt(_bal(), wallet.heldTotal() + wallet.lienUnpaid(), "property 2 is broken here");

        // The held money itself is safe: the lender cannot collect it ...
        assertEq(wallet.settleLien(), 0);
        // ... and the run can still be billed, after which nothing is owed.
        vm.prank(operator);
        wallet.charge("r1", 500_000);
        assertEq(wallet.lienUnpaid(), 0);
    }

    /// The same early checkpoint, with money in the wallet that was the owner's
    /// before the lien began: the lender is paid a share of profit that the run's
    /// bill then wipes out, out of the owner's own money.
    function test_finding_an_early_checkpoint_pays_the_lien_from_the_owners_money() public {
        usdg.mint(address(wallet), 1e6); // the owner's, before any lien
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        assertEq(wallet.withdrawable(), 1e6, "all of it is the owner's to take");

        vm.prank(operator);
        wallet.pay(customer, 600_000, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 500_000);
        vm.prank(operator);
        wallet.settle(1_600_000); // counts the unbilled $0.60 as final

        assertEq(wallet.settleLien(), 600_000, "the lender collects $0.60");

        vm.prank(operator);
        wallet.charge("r1", 500_000); // the run cost all $0.60
        (,,,, uint256 baseProfit) = wallet.lien();
        assertEq(wallet.profit(), baseProfit, "the lien has earned nothing");
        assertEq(usdg.balanceOf(lender), 600_000, "yet the lender holds $0.60");
        assertEq(wallet.withdrawable(), 400_000, "and the owner's $1.00 is now $0.40");
    }

    /// Anyone can ask for a checkpoint and take it a day later. If a hold is still
    /// open then, its money is counted as final profit. (The contract's comments
    /// say so: the meter must bill or release within the day.)
    function test_finding_a_taken_checkpoint_counts_held_money() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        vm.prank(operator);
        wallet.pay(customer, 600_000, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 500_000);

        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();

        assertEq(wallet.heldTotal(), 600_000, "the hold is still open");
        assertEq(wallet.lienUnpaid(), 600_000);
        assertLt(_bal(), wallet.heldTotal() + wallet.lienUnpaid(), "property 2 is broken here");
        assertEq(wallet.settleLien(), 0, "the held money itself cannot be collected");
    }
}
