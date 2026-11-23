// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactoryV4} from "../src/ZeroLuxFactoryV4.sol";
import {AgentWalletV4} from "../src/AgentWalletV4.sol";
import {MockUSDGV3} from "./V3.t.sol";

/// A hostile operator against three version 4 wallets that hold idle money.
///
/// The operator is the factory's meter and so the meter of all three wallets.
/// It holds a stolen key and no scruples: it calls every function the wallet
/// has, in any order, with any arguments, for runs that exist and runs it made
/// up. The owners have set the limits as high as they go and listed every
/// other wallet as payable, so nothing but the wallet's own rule stands between
/// the operator and the money. Customers keep paying, and (the stand-in USDG
/// checks no signature) the operator may submit a payment from any of them, or
/// from itself, for any amount, with any budget.
///
/// Around every operator call the handler checks the two things version 4 is for:
///   - USDG reaches the treasury only in a charge or refund of a run, and for
///     each run never more than was paid INTO the wallet for that run;
///   - no wallet's idle money (balance less what is held for runs and what is
///     parked for others) is lower after the call than before it.
/// Idle money may fall only by the owner's withdrawal and by a payout to the
/// lien payee, which the handler makes as separate, non-operator actions.
/// Nothing reverts: every call is tried, so fail-on-revert is on.
contract HostileOperatorHandler is Test {
    uint128 internal constant MAX = type(uint128).max;

    MockUSDGV3 public usdg;
    ZeroLuxFactoryV4 public factory;
    AgentWalletV4[3] public wallets;
    address[3] public owners;
    address[3] public customers;
    address public operator;
    address public treasury;
    address public payee = makeAddr("hv4-payee");
    address internal stranger = makeAddr("hv4-stranger");

    // ---- ghost books ----
    mapping(uint256 => bytes32[]) internal ids; // every run id ever tried on a wallet that got a payment
    mapping(uint256 => mapping(bytes32 => uint256)) public paidIn; // paid into the wallet for that run
    mapping(uint256 => mapping(bytes32 => uint256)) public toTreasury; // sent to the treasury for that run
    mapping(uint256 => uint256) public floor; // idle money that must still be there: deposits less withdrawals and lien payouts
    uint256 public treasuryAttributed; // every unit the treasury received, each counted against a run
    uint256 public paidFromOutside; // payments by customers and by the operator itself

    string public breach; // the first rule broken, if any
    mapping(string => uint256) public done;

    uint256[3] internal idleBefore;
    uint256 internal treasuryBefore;
    uint256 internal seq;
    uint256 internal nonceSeq;

    constructor(MockUSDGV3 usdg_, ZeroLuxFactoryV4 factory_, address operator_, address treasury_) {
        usdg = usdg_;
        factory = factory_;
        operator = operator_;
        treasury = treasury_;
        uint16[3] memory markups = [uint16(2_000), 500, 0];
        for (uint256 i; i < 3; i++) {
            owners[i] = makeAddr(string.concat("hv4-owner", vm.toString(i)));
            customers[i] = makeAddr(string.concat("hv4-customer", vm.toString(i)));
            vm.prank(operator_); // only the operator may make a wallet below the published markup
            (, address w) = factory_.createAgent(owners[i], MAX, MAX, keccak256("spec"), "", treasury_, markups[i]);
            wallets[i] = AgentWalletV4(w);
            usdg_.mint(w, 1_000e6); // the owner's earnings, idle
            floor[i] = 1_000e6;
        }
        for (uint256 i; i < 3; i++) {
            vm.startPrank(owners[i]);
            for (uint256 j; j < 3; j++) {
                if (i != j) wallets[i].setPayable(address(wallets[j]), true);
            }
            vm.stopPrank();
        }
        // One wallet is under a lien, so the checkpoint has something to move.
        vm.prank(owners[0]);
        wallets[0].setLien(payee, 3_000, 0);
    }

    // ---- helpers ----

    function idle(uint256 w) public view returns (uint256) {
        AgentWalletV4 x = wallets[w];
        return usdg.balanceOf(address(x)) - x.heldTotal() - x.parkedTotal();
    }

    function idCount(uint256 w) external view returns (uint256) {
        return ids[w].length;
    }

    function idAt(uint256 w, uint256 i) external view returns (bytes32) {
        return ids[w][i];
    }

    function _break(string memory what) internal {
        if (bytes(breach).length == 0) breach = what;
    }

    function _fresh() internal returns (bytes32) {
        return keccak256(abi.encode("hv4-run", ++seq));
    }

    /// A run that was paid for (most often one of the latest, which are the ones
    /// still open), or, one time in six or when there is none, one that never was.
    function _id(uint256 w, uint256 seed) internal returns (bytes32) {
        uint256 n = ids[w].length;
        if (n == 0 || seed % 6 == 0) return _fresh();
        if (seed % 6 == 1) return ids[w][(seed >> 8) % n];
        return ids[w][n - 1 - ((seed >> 8) % (n < 4 ? n : 4))];
    }

    /// The largest budget a payment of `value` can carry on wallet `w`.
    function _maxBudget(uint256 w, uint256 value) internal view returns (uint256) {
        return (value * 10_000) / (10_000 + wallets[w].markupBps());
    }

    function _snap() internal {
        for (uint256 i; i < 3; i++) {
            idleBefore[i] = idle(i);
        }
        treasuryBefore = usdg.balanceOf(treasury);
    }

    /// After an operator call. `billing`: the call was a charge or refund of run `id` on wallet `w`.
    function _check(uint256 w, bytes32 id, bool billing) internal {
        for (uint256 i; i < 3; i++) {
            if (idle(i) < idleBefore[i]) _break("an operator call lowered a wallet's idle money");
        }
        uint256 got = usdg.balanceOf(treasury) - treasuryBefore;
        if (got == 0) return;
        if (!billing) {
            _break("the treasury was paid outside a charge or refund");
            return;
        }
        toTreasury[w][id] += got;
        treasuryAttributed += got;
        if (toTreasury[w][id] > paidIn[w][id]) _break("the treasury got more for a run than was paid in for it");
    }

    /// The operator changed nothing that is the owner's to set.
    function _ownerSettingsStand(uint256 w) internal {
        AgentWalletV4 x = wallets[w];
        if (
            x.owner() != owners[w] || x.pendingOwner() != address(0) || x.paused() || x.customOperator() != address(0)
                || x.perRunCap() != MAX || x.perDayCap() != MAX || x.treasury() != treasury
        ) _break("the operator changed an owner setting");
        (address p,,,,) = x.lien();
        if (p != (w == 0 ? payee : address(0))) _break("the operator changed a lien");
    }

    // ---- the operator: payments ----

    /// Submit a payment. From a customer, from the operator itself, or (which must
    /// fail) from the wallet being paid; any value, any budget, a new run id or one
    /// already used; sometimes a nonce that was already spent.
    struct Payment {
        address from;
        uint256 value;
        bytes32 nonce;
        bytes32 id;
        uint256 budget;
        bool recv;
    }

    function pay(uint256 wSeed, uint256 fromSeed, uint256 value, uint256 budget, uint256 idSeed, bool recv) public {
        uint256 w = wSeed % 3;
        Payment memory p;
        p.from = fromSeed % 7 == 6 ? address(wallets[w]) : fromSeed % 4 == 3 ? operator : customers[fromSeed % 3];
        p.value = bound(value, 0, 400e6);
        // Most often a budget the payment can carry; sometimes anything at all.
        p.budget = idSeed % 4 != 0 ? bound(budget, 0, _maxBudget(w, p.value)) : bound(budget, 0, 2_000e6);
        p.id = idSeed % 9 == 0 ? _id(w, idSeed >> 4) : _fresh();
        p.nonce = (fromSeed >> 16) % 9 == 0 && nonceSeq != 0 ? bytes32(nonceSeq) : bytes32(++nonceSeq);
        p.recv = recv;
        if (p.from != address(wallets[w])) usdg.mint(p.from, p.value);

        _snap();
        if (_submit(w, p)) {
            if (p.budget + (p.budget * wallets[w].markupBps()) / 10_000 > p.value) _break("a hold was opened for more than was paid");
            if (paidIn[w][p.id] != 0) _break("a run id took a second payment");
            paidIn[w][p.id] += p.value;
            paidFromOutside += p.value;
            ids[w].push(p.id);
            done["pay"]++;
        }
        _check(w, p.id, false);
    }

    function _submit(uint256 w, Payment memory p) internal returns (bool ok) {
        address x = address(wallets[w]);
        uint256 balBefore = usdg.balanceOf(x);
        bytes memory data = _payData(p);
        vm.prank(operator);
        (ok,) = x.call(data);
        if (ok && usdg.balanceOf(x) != balBefore + p.value) _break("a hold was opened and the payment is not there");
    }

    function _payData(Payment memory p) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            AgentWalletV4.pay.selector,
            p.from, p.value, 0, block.timestamp + 600, p.nonce, p.recv ? 28 : 27, bytes32(0), bytes32(0), p.id, p.budget, p.recv
        );
    }

    // ---- the operator: billing ----

    // The same again, so that payments and bills are the larger part of what happens.
    function pay2(uint256 wSeed, uint256 fromSeed, uint256 value, uint256 budget, uint256 idSeed, bool recv) external {
        pay(wSeed, fromSeed, value, budget, idSeed, recv);
    }

    function pay3(uint256 wSeed, uint256 fromSeed, uint256 value, uint256 budget, uint256 idSeed, bool recv) external {
        pay(wSeed, fromSeed, value, budget, idSeed, recv);
    }

    function charge2(uint256 wSeed, uint256 idSeed, uint256 cost, uint256 mode, uint256 upTo) external {
        charge(wSeed, idSeed, cost, mode, upTo);
    }

    function charge3(uint256 wSeed, uint256 idSeed, uint256 cost, uint256 mode, uint256 upTo) external {
        charge(wSeed, idSeed, cost, mode, upTo);
    }

    function payAgent2(uint256 wSeed, uint256 idSeed, uint256 toSeed, uint256 value, uint256 subBudget) external {
        payAgent(wSeed, idSeed, toSeed, value, subBudget);
    }

    function charge(uint256 wSeed, uint256 idSeed, uint256 cost, uint256 mode, uint256 upTo) public {
        uint256 w = wSeed % 3;
        AgentWalletV4 x = wallets[w];
        bytes32 id = _id(w, idSeed);
        // Sometimes exactly what the run may cost, sometimes anything at all.
        (,,,, uint80 left,) = x.holds(id);
        cost = mode % 4 == 0 ? left : mode % 4 == 3 ? bound(cost, 0, 2_000e6) : bound(cost, left == 0 ? 0 : 1, left);
        _snap();
        vm.startPrank(operator);
        if (mode % 3 == 0) {
            try x.charge(id, cost, bytes32(seq)) {
                done["charge"]++;
            } catch {}
        } else if (mode % 3 == 1) {
            try x.chargeAndSettle(id, cost, upTo, bytes32(seq)) {
                done["chargeAndSettle"]++;
            } catch {}
        } else {
            try x.refund(id, cost, bytes32(seq)) {
                done["refund"]++;
            } catch {}
        }
        vm.stopPrank();
        _check(w, id, true);
    }

    function release(uint256 wSeed, uint256 idSeed) external {
        uint256 w = wSeed % 3;
        bytes32 id = _id(w, idSeed);
        _snap();
        vm.prank(operator);
        try wallets[w].release(id) {
            done["release"]++;
        } catch {}
        _check(w, id, false);
    }

    function payAgent(uint256 wSeed, uint256 idSeed, uint256 toSeed, uint256 value, uint256 subBudget) public {
        uint256 w = wSeed % 3;
        uint256 t = toSeed % 3;
        AgentWalletV4 x = wallets[w];
        bytes32 id = _id(w, idSeed);
        (,,,, uint80 left,) = x.holds(id);
        value = toSeed % 4 == 0 ? bound(value, 0, 2_000e6) : bound(value, 0, left);
        subBudget = bound(subBudget, 0, toSeed % 5 == 0 ? 2_000e6 : _maxBudget(t, value));
        bytes32 subId = _fresh();
        bytes32 key = wallets[t].subRunKey(address(x), subId);
        _snap();
        vm.prank(operator);
        try x.payAgent(id, address(wallets[t]), value, subId, subBudget) {
            if (value > paidIn[w][id]) _break("a run paid another agent more than was paid in for it");
            paidIn[t][key] += value;
            ids[t].push(key);
            done["payAgent"]++;
        } catch {}
        _check(w, id, false);
    }

    function settle(uint256 wSeed, uint256 upTo) external {
        uint256 w = wSeed % 3;
        _snap();
        vm.prank(operator);
        try wallets[w].settle(upTo % 3 == 0 ? type(uint256).max : upTo % 3 == 1 ? 0 : upTo) {
            done["settle"]++;
        } catch {}
        _check(w, bytes32(0), false);
    }

    // ---- the operator: the old way in, and everything else the wallet has ----

    /// `open(runId, budget)`: how version 3 let the meter set the wallet's own money aside.
    function openOld(uint256 wSeed, uint256 idSeed, uint256 budget) external {
        uint256 w = wSeed % 3;
        bytes32 id = _id(w, idSeed);
        _snap();
        uint256 heldBefore = wallets[w].heldTotal();
        vm.prank(operator);
        (bool ok,) = address(wallets[w]).call(abi.encodeWithSignature("open(bytes32,uint256)", id, bound(budget, 0, 900e6)));
        if (ok || wallets[w].heldTotal() != heldBefore) _break("open went through");
        _check(w, id, false);
        done["openOld"]++;
    }

    /// Every other external function of the wallet, called by the operator.
    function anythingElse(uint256 wSeed, uint256 pick, uint256 a, uint256 b) external {
        uint256 w = wSeed % 3;
        AgentWalletV4 x = wallets[w];
        address other = address(wallets[(w + 1 + pick % 2) % 3]);
        bytes32 id = _id(w, a);
        a = bound(a, 0, 2_000e6);
        b = bound(b, 0, 2_000e6);
        usdg.mint(operator, 1e6);
        vm.prank(operator);
        usdg.approve(address(x), type(uint256).max); // so a pull from the operator is never refused for want of approval

        bytes[24] memory calls = [
            abi.encodeCall(x.withdraw, (address(usdg), operator, a)),
            abi.encodeCall(x.withdraw, (address(usdg), treasury, 1)),
            abi.encodeCall(x.setLimits, (uint128(a), uint128(b))),
            abi.encodeCall(x.setOperator, (operator)),
            abi.encodeCall(x.setPayable, (other, pick % 2 == 0)),
            abi.encodeCall(x.adoptTerms, (treasury, uint16(a))),
            abi.encodeCall(x.setPaused, (true)),
            abi.encodeCall(x.transferOwnership, (operator)),
            abi.encodeCall(x.acceptOwnership, ()),
            abi.encodeCall(x.setLien, (operator, 10_000, 0)),
            abi.encodeCall(x.endLien, ()),
            abi.encodeCall(x.setLienPayee, (operator)),
            abi.encodeCall(x.consentToTerms, (treasury, 5_000)),
            abi.encodeCall(x.consentToOperator, (operator)),
            abi.encodeCall(x.consentToPayable, (other)),
            abi.encodeCall(x.init, (operator, MAX, MAX, 0)),
            abi.encodeCall(x.payFromAgent, (a, id, b, operator)),
            abi.encodeCall(x.returnFromAgent, (id, a)),
            abi.encodeCall(x.claimParked, (operator)),
            abi.encodeCall(x.collectParked, (other)),
            abi.encodeCall(x.retryReturn, (id)),
            abi.encodeCall(x.notePayer, (operator)),
            abi.encodeCall(x.requestCheckpoint, ()),
            abi.encodeCall(x.takeCheckpoint, ())
        ];
        _snap();
        uint256 opBefore = usdg.balanceOf(operator);
        vm.prank(operator);
        (bool ok,) = address(x).call(calls[pick % calls.length]);
        if (ok) done["anythingElse"]++;
        if (usdg.balanceOf(operator) > opBefore) _break("the operator took money out of a wallet");
        _check(w, id, false);
        _ownerSettingsStand(w);
        // What the operator gave away by trying is a deposit like any other.
        if (usdg.balanceOf(operator) < opBefore) paidFromOutside += opBefore - usdg.balanceOf(operator);
    }

    // ---- everyone else ----

    /// Anyone may release a hold once it is a day old; the payment goes back to its payer.
    function strangerRelease(uint256 wSeed, uint256 idSeed) external {
        uint256 w = wSeed % 3;
        bytes32 id = _id(w, idSeed);
        _snap();
        vm.prank(stranger);
        try wallets[w].release(id) {
            done["strangerRelease"]++;
        } catch {}
        _check(w, id, false);
    }

    function ownerDeposit(uint256 wSeed, uint256 amount) external {
        uint256 w = wSeed % 3;
        amount = bound(amount, 1, 200e6);
        usdg.mint(address(wallets[w]), amount);
        floor[w] += amount;
    }

    function ownerWithdraw(uint256 wSeed, uint256 amount) external {
        uint256 w = wSeed % 3;
        amount = bound(amount, 0, wallets[w].withdrawable());
        uint256 before = idle(w);
        vm.prank(owners[w]);
        wallets[w].withdraw(address(usdg), owners[w], amount);
        if (idle(w) != before - amount) _break("a withdrawal moved something other than its amount");
        floor[w] = floor[w] > amount ? floor[w] - amount : 0;
        done["ownerWithdraw"]++;
    }

    function settleLien(uint256 wSeed) external {
        uint256 w = wSeed % 3;
        uint256 before = idle(w);
        vm.prank(stranger);
        try wallets[w].settleLien() returns (uint256 amount) {
            if (idle(w) != before - amount) _break("a lien payout moved something other than its amount");
            floor[w] = floor[w] > amount ? floor[w] - amount : 0;
            if (amount != 0) done["settleLien"]++;
        } catch {}
    }

    function skipTime(uint32 secs) external {
        skip(bound(secs, 1, 30 hours));
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 150
/// forge-config: default.invariant.fail-on-revert = true
contract InvariantHostileV4Test is Test {
    MockUSDGV3 usdg;
    ZeroLuxFactoryV4 factory;
    HostileOperatorHandler handler;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDGV3();
        factory = new ZeroLuxFactoryV4(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        handler = new HostileOperatorHandler(usdg, factory, operator, treasury);
        targetContract(address(handler));
    }

    function invariant_1_no_operator_call_broke_a_rule() public view {
        assertEq(handler.breach(), "");
    }

    function invariant_2_for_every_run_the_treasury_got_no_more_than_was_paid_in_for_it() public view {
        for (uint256 w; w < 3; w++) {
            uint256 n = handler.idCount(w);
            for (uint256 i; i < n; i++) {
                bytes32 id = handler.idAt(w, i);
                assertLe(handler.toTreasury(w, id), handler.paidIn(w, id));
            }
        }
    }

    function invariant_3_every_unit_in_the_treasury_is_counted_against_a_run() public view {
        assertEq(usdg.balanceOf(treasury), handler.treasuryAttributed());
        assertLe(usdg.balanceOf(treasury), handler.paidFromOutside(), "the treasury holds more than was ever paid in");
    }

    function invariant_4_idle_money_is_never_below_what_the_owner_left_there() public view {
        for (uint256 w; w < 3; w++) {
            assertGe(handler.idle(w), handler.floor(w));
        }
    }

    function invariant_5_every_wallet_covers_what_it_holds_parks_and_owes() public view {
        for (uint256 w; w < 3; w++) {
            AgentWalletV4 x = handler.wallets(w);
            assertGe(usdg.balanceOf(address(x)), x.heldTotal() + x.parkedTotal() + x.lienUnpaid());
            assertLe(x.settledProfit(), x.profit());
        }
    }

    function invariant_6_the_operator_holds_nothing_it_did_not_bring() public view {
        // It is minted what it pays with and one unit per `anythingElse`; it never receives.
        assertEq(usdg.allowance(address(handler.wallets(0)), operator), 0);
    }

    /// Not a property: shows (with -vv) what the last run exercised.
    function afterInvariant() public virtual {
        string[10] memory names = [
            "pay", "charge", "chargeAndSettle", "refund", "release", "payAgent", "settle", "anythingElse", "strangerRelease", "settleLien"
        ];
        for (uint256 i; i < names.length; i++) {
            emit log_named_uint(names[i], handler.done(names[i]));
        }
        emit log_named_uint("treasury", usdg.balanceOf(treasury));
    }
}
