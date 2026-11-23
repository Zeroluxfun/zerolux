// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZeroLuxFactoryV4} from "../src/ZeroLuxFactoryV4.sol";
import {AgentWalletV4} from "../src/AgentWalletV4.sol";
import {MockUSDGV3} from "./V3.t.sol";

/// Independent adversarial handler: tree-level bound, blocklist toggles, owner pauses, insiders as payers.
contract AuditHandler is Test {
    uint128 constant MAX = type(uint128).max;
    MockUSDGV3 public usdg;
    ZeroLuxFactoryV4 public factory;
    AgentWalletV4[3] public W;
    address[3] public owners;
    address[4] public cust; // 3 customers + payee-as-customer
    address public operator;
    address public treasury;
    address public payee = makeAddr("au-payee");
    address stranger = makeAddr("au-stranger");

    struct Ref { uint256 w; bytes32 id; }
    Ref[] public refs;
    mapping(uint256 => mapping(bytes32 => bytes32)) public rootOf; // tree root key (hash of w,id)
    mapping(bytes32 => uint256) public rootPaid;
    mapping(bytes32 => uint256) public rootTreasury;
    mapping(address => uint256) public mintedTo;
    uint256 public seq;
    uint256 public treasuryTotal;
    uint256 public outsideIn;
    string public breach;
    mapping(string => uint256) public done;

    constructor(MockUSDGV3 u, ZeroLuxFactoryV4 f, address op, address tr) {
        usdg = u; factory = f; operator = op; treasury = tr;
        uint16[3] memory mk = [uint16(2_000), 0, 700];
        for (uint256 i; i < 3; i++) {
            owners[i] = makeAddr(string.concat("au-owner", vm.toString(i)));
            cust[i] = makeAddr(string.concat("au-cust", vm.toString(i)));
            vm.prank(op);
            (, address w) = f.createAgent(owners[i], MAX, MAX, keccak256("s"), "", tr, mk[i]);
            W[i] = AgentWalletV4(w);
            u.mint(w, 500e6);
        }
        cust[3] = payee;
        for (uint256 i; i < 3; i++) {
            vm.startPrank(owners[i]);
            for (uint256 j; j < 3; j++) if (i != j) W[i].setPayable(address(W[j]), true);
            vm.stopPrank();
        }
        vm.prank(owners[0]);
        W[0].setLien(payee, 4_000, 0);
    }

    function _b(string memory s) internal { if (bytes(breach).length == 0) breach = s; }
    function refCount() external view returns (uint256) { return refs.length; }
    function _fresh() internal returns (bytes32) { return keccak256(abi.encode("au", ++seq)); }
    function _key(uint256 w, bytes32 id) internal pure returns (bytes32) { return keccak256(abi.encode(w, id)); }

    function _pick(uint256 s) internal view returns (uint256 w, bytes32 id) {
        if (refs.length == 0 || s % 7 == 0) return (s % 3, keccak256(abi.encode("none", s)));
        uint256 n = refs.length;
        Ref memory r = s % 3 == 0 ? refs[(s >> 8) % n] : refs[n - 1 - ((s >> 8) % (n < 5 ? n : 5))];
        return (r.w, r.id);
    }

    function pay(uint256 ws, uint256 fs, uint256 value, uint256 budget, uint256 ids) external {
        uint256 w = ws % 3;
        address from = cust[fs % 4];
        if (fs % 11 == 0) from = owners[w];
        value = bound(value, 0, 300e6);
        uint256 mx = value * 10_000 / (10_000 + W[w].markupBps());
        budget = ids % 3 == 0 ? bound(budget, 0, 900e6) : bound(budget, 0, mx);
        bytes32 id = (ids % 8 == 0 && refs.length > 0) ? refs[ids % refs.length].id : _fresh();
        usdg.mint(from, value); mintedTo[from] += value;
        bool ok = _pay(w, from, value, id, budget);
        if (ok) {
            bytes32 k = _key(w, id);
            if (rootOf[w][id] != bytes32(0)) _b("id reused for second payment");
            rootOf[w][id] = k; rootPaid[k] = value; outsideIn += value;
            refs.push(Ref(w, id)); done["pay"]++;
        }
    }

    function _pay(uint256 w, address from, uint256 value, bytes32 id, uint256 budget) internal returns (bool ok) {
        bytes memory d = abi.encodeWithSelector(AgentWalletV4.pay.selector, from, value, 0, block.timestamp + 600, bytes32(++seq), 27, bytes32(0), bytes32(0), id, budget, false);
        vm.prank(operator);
        (ok,) = address(W[w]).call(d);
    }

    function payAgent(uint256 ws, uint256 to, uint256 value, uint256 sb) external {
        (uint256 w, bytes32 id) = _pick(ws);
        uint256 t = to % 3;
        (,,,, uint80 left,) = W[w].holds(id);
        value = to % 5 == 0 ? bound(value, 0, 900e6) : bound(value, 0, left);
        sb = bound(sb, 0, value * 10_000 / (10_000 + W[t].markupBps()));
        bytes32 sid = _fresh();
        bytes32 key = W[t].subRunKey(address(W[w]), sid);
        vm.prank(operator);
        try W[w].payAgent(id, address(W[t]), value, sid, sb) {
            rootOf[t][key] = rootOf[w][id];
            if (rootOf[w][id] == bytes32(0)) _b("payAgent from unpaid run");
            refs.push(Ref(t, key)); done["payAgent"]++;
        } catch {}
    }

    function bill(uint256 ws, uint256 cost, uint256 mode, uint256 upTo, bool stranger_) external {
        (uint256 w, bytes32 id) = _pick(ws);
        (,,,, uint80 left,) = W[w].holds(id);
        cost = mode % 3 == 0 ? left : bound(cost, 0, mode % 5 == 0 ? 900e6 : left);
        uint256 tb = usdg.balanceOf(treasury);
        vm.startPrank(stranger_ ? stranger : operator);
        if (mode % 4 == 0) { try W[w].charge(id, cost, bytes32(0)) { done["charge"]++; } catch {} }
        else if (mode % 4 == 1) { try W[w].chargeAndSettle(id, cost, upTo, bytes32(0)) { done["cs"]++; } catch {} }
        else if (mode % 4 == 2) { try W[w].refund(id, cost, bytes32(0)) { done["refund"]++; } catch {} }
        else { try W[w].release(id) { done["release"]++; } catch {} }
        vm.stopPrank();
        uint256 got = usdg.balanceOf(treasury) - tb;
        if (got != 0) {
            bytes32 r = rootOf[w][id];
            if (mode % 4 == 3) _b("release paid treasury");
            if (stranger_) _b("stranger paid treasury");
            rootTreasury[r] += got; treasuryTotal += got;
            if (r == bytes32(0) || rootTreasury[r] > rootPaid[r]) _b("tree paid treasury more than root payment");
        }
    }

    function misc(uint256 ws, uint256 pick, uint256 a) external {
        (uint256 w, bytes32 id) = _pick(ws);
        uint256 i = ws % 3;
        uint256 tb = usdg.balanceOf(treasury);
        if (pick % 9 == 0) { vm.prank(operator); try W[i].settle(a % 2 == 0 ? type(uint256).max : a) {} catch {} }
        else if (pick % 9 == 1) { try W[w].retryReturn(id) { done["retry"]++; } catch {} }
        else if (pick % 9 == 2) { vm.prank(cust[a % 4]); try W[i].claimParked(cust[a % 4]) { done["claim"]++; } catch {} }
        else if (pick % 9 == 3) { try W[i].collectParked(address(W[(i + 1) % 3])) {} catch {} }
        else if (pick % 9 == 4) { try W[i].requestCheckpoint() {} catch {} }
        else if (pick % 9 == 5) { try W[i].takeCheckpoint() {} catch {} }
        else if (pick % 9 == 6) { try W[i].settleLien() {} catch {} }
        else if (pick % 9 == 7) { usdg.setBlocked(a % 2 == 0 ? cust[a % 4] : address(W[a % 3]), a % 3 == 0); }
        else { vm.prank(owners[i]); W[i].setPaused(a % 4 == 0); }
        if (usdg.balanceOf(treasury) != tb) _b("misc paid treasury");
    }

    function ownerWithdraw(uint256 ws, uint256 a) external {
        uint256 i = ws % 3;
        a = bound(a, 0, W[i].withdrawable());
        vm.prank(owners[i]);
        try W[i].withdraw(address(usdg), owners[i], a) {} catch { require(usdg.blocked(address(W[i])) || usdg.blocked(owners[i])); }
    }

    function skipTime(uint32 s) external { skip(bound(s, 1, 30 hours)); }
}

/// forge-config: default.invariant.runs = 400
/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.fail-on-revert = true
contract AuditV4Test is Test {
    MockUSDGV3 usdg;
    ZeroLuxFactoryV4 factory;
    AuditHandler h;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDGV3();
        factory = new ZeroLuxFactoryV4(address(usdg), makeAddr("admin"), makeAddr("operator"), makeAddr("treasury"), 2_000, address(0), makeAddr("guardian"));
        h = new AuditHandler(usdg, factory, makeAddr("operator"), makeAddr("treasury"));
        targetContract(address(h));
    }

    function invariant_a_no_breach() public view { assertEq(h.breach(), ""); }

    function invariant_b_solvency_and_hold_books() public view {
        for (uint256 w; w < 3; w++) {
            AgentWalletV4 x = h.W(w);
            assertGe(usdg.balanceOf(address(x)), x.heldTotal() + x.parkedTotal() + x.lienUnpaid(), "solvency");
            assertLe(x.settledProfit(), x.profit());
        }
        uint256[3] memory sum;
        uint256 n = h.refCount();
        for (uint256 i; i < n; i++) {
            (uint256 w, bytes32 id) = h.refs(i);
            (,,, uint96 amount, uint80 budget, uint80 reserved) = h.W(w).holds(id);
            sum[w] += amount;
            assertGe(amount, reserved);
            assertGe(reserved, budget);
        }
        for (uint256 w; w < 3; w++) assertEq(sum[w], h.W(w).heldTotal(), "heldTotal books");
    }

    function invariant_c_customers_never_get_more_than_they_paid() public view {
        for (uint256 i; i < 3; i++) {
            address c = h.cust(i);
            assertLe(usdg.balanceOf(c), h.mintedTo(c));
        }
        assertLe(usdg.balanceOf(h.treasury()), h.outsideIn());
    }
}

contract AuditV4Cov is AuditV4Test {
    function afterInvariant() public {
        string[8] memory n = ["pay", "payAgent", "charge", "cs", "refund", "release", "retry", "claim"];
        for (uint256 i; i < 8; i++) emit log_named_uint(n[i], h.done(n[i]));
    }
}
