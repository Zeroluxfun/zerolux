// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LuxLocker} from "../src/LuxLocker.sol";

/// A plain 18 decimal token standing in for $LUX in tests. `mode` turns it into
/// the awkward tokens the locker has to cope with.
contract MockLux {
    enum Mode {
        Plain, // returns true
        NoReturn, // returns nothing, as some old tokens do
        False, // returns false and moves nothing
        Fee // keeps `feeBps` of every transfer
    }

    string public constant name = "Lux";
    string public constant symbol = "LUX";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    Mode public mode;
    uint16 public feeBps;

    // A call made in the middle of the next transfer, to try to get back in.
    address public hookTarget;
    bytes public hookData;
    bool public hookRan;
    bool public hookOk;
    bytes public hookResult;

    function setMode(Mode m, uint16 feeBps_) external {
        mode = m;
        feeBps = feeBps_;
    }

    function arm(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
        hookRan = false;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external {
        _answer(_move(msg.sender, to, amount));
    }

    function transferFrom(address from, address to, uint256 amount) external {
        if (mode != Mode.False) allowance[from][msg.sender] -= amount;
        _answer(_move(from, to, amount));
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        if (mode == Mode.False) return false;
        balanceOf[from] -= amount;
        uint256 fee = mode == Mode.Fee ? (amount * feeBps) / 10_000 : 0;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        if (hookTarget != address(0)) {
            address t = hookTarget;
            hookTarget = address(0);
            (hookOk, hookResult) = t.call(hookData);
            hookRan = true;
        }
        return true;
    }

    function _answer(bool ok) private view {
        if (mode == Mode.NoReturn) {
            assembly {
                return(0, 0)
            }
        }
        assembly {
            mstore(0, ok)
            return(0, 32)
        }
    }
}

/// Holds a position and tries to take it out twice in one go.
contract Reenterer {
    LuxLocker immutable locker;
    MockLux immutable lux;
    bool public againRan;
    bool public againOk;
    bytes public againResult;

    constructor(LuxLocker locker_, MockLux lux_) {
        locker = locker_;
        lux = lux_;
        lux_.approve(address(locker_), type(uint256).max);
    }

    function lock(uint256 amount, uint64 unlockAt) external {
        locker.lock(amount, unlockAt);
    }

    function withdraw() external {
        locker.withdraw();
    }

    /// Called by the token in the middle of the locker's transfer.
    function again() external {
        againRan = true;
        (againOk, againResult) = address(locker).call(abi.encodeCall(LuxLocker.withdraw, ()));
    }
}

abstract contract LockerBase is Test {
    MockLux lux;
    LuxLocker locker;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");

    uint64 constant DAY = 1 days;
    uint256 constant START = 1_800_000_000;

    function setUp() public virtual {
        vm.warp(START);
        lux = new MockLux();
        locker = new LuxLocker(address(lux));
        _fund(alice, 1_000_000e18);
        _fund(bob, 1_000_000e18);
        _fund(mallory, 1_000_000e18);
    }

    function _fund(address who, uint256 amount) internal {
        lux.mint(who, amount);
        vm.prank(who);
        lux.approve(address(locker), type(uint256).max);
    }

    function _now() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    function _lock(address who, uint256 amount, uint64 unlockAt) internal {
        vm.prank(who);
        locker.lock(amount, unlockAt);
    }

    function _amount(address who) internal view returns (uint256 a) {
        (a,) = locker.locked(who);
    }

    function _unlockAt(address who) internal view returns (uint64 u) {
        (, u) = locker.locked(who);
    }
}

contract LuxLockerTest is LockerBase {
    event Locked(address indexed account, uint256 received, uint256 amount, uint64 unlockAt);
    event Extended(address indexed account, uint64 unlockAt);
    event Withdrawn(address indexed account, uint256 amount);

    // ---- construction ----

    function test_the_token_is_fixed_and_must_be_a_contract() public {
        assertEq(locker.token(), address(lux));
        assertEq(uint256(locker.MIN_LOCK()), 7 days);
        assertEq(uint256(locker.MAX_LOCK()), 730 days);
        vm.expectRevert(LuxLocker.ZeroAddress.selector);
        new LuxLocker(address(0));
        vm.expectRevert(LuxLocker.NotAToken.selector);
        new LuxLocker(makeAddr("no code here"));
    }

    // ---- lock ----

    function test_lock_pulls_the_tokens_and_records_the_position() public {
        uint64 until = _now() + 30 * DAY;
        vm.expectEmit(true, true, true, true, address(locker));
        emit Locked(alice, 100e18, 100e18, until);
        vm.prank(alice);
        assertEq(locker.lock(100e18, until), 100e18);

        (uint256 amount, uint64 unlockAt) = locker.locked(alice);
        assertEq(amount, 100e18);
        assertEq(unlockAt, until);
        assertEq(locker.lockedOf(alice), 100e18);
        assertEq(locker.totalLocked(), 100e18);
        assertEq(lux.balanceOf(address(locker)), 100e18);
        assertEq(lux.balanceOf(alice), 1_000_000e18 - 100e18);

        // Another wallet's position is its own.
        _lock(bob, 7e18, _now() + 7 * DAY);
        assertEq(_amount(bob), 7e18);
        assertEq(_amount(alice), 100e18);
        assertEq(locker.totalLocked(), 107e18);
        assertEq(locker.lockedOf(mallory), 0);
    }

    function test_lock_needs_an_amount_an_allowance_and_the_tokens() public {
        vm.prank(alice);
        vm.expectRevert(LuxLocker.ZeroAmount.selector);
        locker.lock(0, _now() + 30 * DAY);

        address poor = makeAddr("poor");
        vm.prank(poor);
        lux.approve(address(locker), type(uint256).max);
        vm.prank(poor);
        vm.expectRevert(LuxLocker.TransferFailed.selector);
        locker.lock(1e18, _now() + 30 * DAY);

        vm.prank(alice);
        lux.approve(address(locker), 0);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.TransferFailed.selector);
        locker.lock(1e18, _now() + 30 * DAY);
        assertEq(locker.totalLocked(), 0);
    }

    function test_a_lock_runs_at_least_seven_days_and_at_most_two_years() public {
        vm.prank(alice);
        vm.expectRevert(LuxLocker.LockTooShort.selector);
        locker.lock(1e18, _now() + 7 * DAY - 1);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.LockTooShort.selector);
        locker.lock(1e18, _now());
        vm.prank(alice);
        vm.expectRevert(LuxLocker.LockTooShort.selector);
        locker.lock(1e18, 0);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.LockTooLong.selector);
        locker.lock(1e18, _now() + 730 * DAY + 1);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.LockTooLong.selector);
        locker.lock(1e18, type(uint64).max);

        _lock(alice, 1e18, _now() + 7 * DAY); // the shortest
        _lock(bob, 1e18, _now() + 730 * DAY); // the longest
        assertEq(_unlockAt(alice), _now() + 7 * DAY);
        assertEq(_unlockAt(bob), _now() + 730 * DAY);
    }

    // ---- adding ----

    function test_adding_keeps_the_unlock_time_or_moves_it_later() public {
        uint64 until = _now() + 90 * DAY;
        _lock(alice, 100e18, until);

        // Keep it.
        vm.expectEmit(true, true, true, true, address(locker));
        emit Locked(alice, 50e18, 150e18, until);
        _lock(alice, 50e18, until);
        assertEq(_amount(alice), 150e18);
        assertEq(_unlockAt(alice), until);

        // Move it later: the whole position moves.
        _lock(alice, 25e18, until + 30 * DAY);
        assertEq(_amount(alice), 175e18);
        assertEq(_unlockAt(alice), until + 30 * DAY);
        assertEq(locker.totalLocked(), 175e18);
        assertEq(lux.balanceOf(address(locker)), 175e18);
    }

    function test_adding_can_never_shorten_a_lock() public {
        uint64 until = _now() + 90 * DAY;
        _lock(alice, 100e18, until);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.CannotShorten.selector);
        locker.lock(1e18, until - 1);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.CannotShorten.selector);
        locker.lock(1e18, _now() + 7 * DAY);
        assertEq(_amount(alice), 100e18);
        assertEq(_unlockAt(alice), until);
    }

    function test_adding_to_a_lock_with_under_seven_days_left_means_locking_seven_days_again() public {
        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);
        vm.warp(until - 3 * DAY);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.LockTooShort.selector);
        locker.lock(1e18, until);
        _lock(alice, 1e18, _now() + 7 * DAY);
        assertEq(_amount(alice), 101e18);
        assertEq(_unlockAt(alice), _now() + 7 * DAY);
    }

    function test_adding_to_an_unlocked_position_locks_all_of_it_again() public {
        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);
        vm.warp(until + 1 * DAY);
        assertEq(locker.lockedOf(alice), 0);
        _lock(alice, 1e18, _now() + 7 * DAY);
        assertEq(locker.lockedOf(alice), 101e18);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.StillLocked.selector);
        locker.withdraw();
    }

    // ---- extend ----

    function test_extend_moves_the_unlock_time_later_and_only_later() public {
        vm.prank(alice);
        vm.expectRevert(LuxLocker.NothingLocked.selector);
        locker.extend(_now() + 30 * DAY);

        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);

        vm.prank(alice);
        vm.expectRevert(LuxLocker.NotLater.selector);
        locker.extend(until);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.NotLater.selector);
        locker.extend(until - 1);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.NotLater.selector);
        locker.extend(0);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.LockTooLong.selector);
        locker.extend(_now() + 730 * DAY + 1);

        vm.expectEmit(true, true, true, true, address(locker));
        emit Extended(alice, until + 1);
        vm.prank(alice);
        locker.extend(until + 1);
        assertEq(_unlockAt(alice), until + 1);
        assertEq(_amount(alice), 100e18, "extending moves no tokens");
        assertEq(lux.balanceOf(address(locker)), 100e18);

        vm.prank(alice);
        locker.extend(_now() + 730 * DAY);
        assertEq(_unlockAt(alice), _now() + 730 * DAY);

        // Nobody can extend for somebody else: the call only ever touches the caller.
        vm.prank(mallory);
        vm.expectRevert(LuxLocker.NothingLocked.selector);
        locker.extend(_now() + 730 * DAY);
    }

    function test_an_unlocked_position_can_be_locked_again_by_extending_into_the_future() public {
        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);
        vm.warp(until + 10 * DAY);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.NotLater.selector);
        locker.extend(_now()); // later than it was, but not in the future
        vm.prank(alice);
        locker.extend(_now() + 1);
        assertEq(locker.lockedOf(alice), 100e18);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.StillLocked.selector);
        locker.withdraw();
    }

    // ---- withdraw ----

    function test_nothing_comes_out_before_the_unlock_time() public {
        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.StillLocked.selector);
        locker.withdraw();
        vm.warp(until - 1);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.StillLocked.selector);
        locker.withdraw();
        assertEq(lux.balanceOf(address(locker)), 100e18);
        assertEq(_amount(alice), 100e18);
    }

    function test_withdraw_at_the_unlock_time_returns_the_whole_position_to_its_owner() public {
        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);
        _lock(alice, 50e18, until);
        _lock(bob, 9e18, until + 30 * DAY);
        vm.warp(until);

        // Only the caller's own position moves, and only to the caller.
        vm.prank(mallory);
        vm.expectRevert(LuxLocker.NothingLocked.selector);
        locker.withdraw();
        vm.prank(bob);
        vm.expectRevert(LuxLocker.StillLocked.selector);
        locker.withdraw();

        vm.expectEmit(true, true, true, true, address(locker));
        emit Withdrawn(alice, 150e18);
        vm.prank(alice);
        assertEq(locker.withdraw(), 150e18);

        assertEq(lux.balanceOf(alice), 1_000_000e18);
        (uint256 amount, uint64 unlockAt) = locker.locked(alice);
        assertEq(amount, 0);
        assertEq(unlockAt, 0);
        assertEq(locker.totalLocked(), 9e18);
        assertEq(lux.balanceOf(address(locker)), 9e18, "bob's tokens are untouched");

        vm.prank(alice);
        vm.expectRevert(LuxLocker.NothingLocked.selector);
        locker.withdraw();

        // A fresh position starts from nothing, and may be shorter than the last.
        _lock(alice, 5e18, _now() + 7 * DAY);
        assertEq(_amount(alice), 5e18);
        assertEq(_unlockAt(alice), _now() + 7 * DAY);
    }

    // ---- views ----

    function test_lockedOf_drops_to_zero_the_moment_the_lock_can_be_withdrawn() public {
        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);
        vm.warp(until - 1);
        assertEq(locker.lockedOf(alice), 100e18);
        vm.warp(until);
        assertEq(locker.lockedOf(alice), 0, "expired, though not withdrawn");
        (uint256 amount, uint64 unlockAt) = locker.locked(alice);
        assertEq(amount, 100e18, "the stored position is still there");
        assertEq(unlockAt, until);
        assertEq(locker.totalLocked(), 100e18);
        vm.warp(until + 365 * DAY);
        assertEq(locker.lockedOf(alice), 0);
    }

    function test_lockedUntil_counts_a_position_that_unlocks_at_that_time_or_later() public {
        uint64 until = _now() + 120 * DAY;
        _lock(alice, 100e18, until);

        assertEq(locker.lockedUntil(alice, _now() + 90 * DAY), 100e18, "locked for at least another 90 days");
        assertEq(locker.lockedUntil(alice, until), 100e18, "to the very second");
        assertEq(locker.lockedUntil(alice, until + 1), 0);
        assertEq(locker.lockedUntil(alice, _now() + 121 * DAY), 0);
        assertEq(locker.lockedUntil(bob, _now() + 1), 0, "no position");
        assertEq(locker.lockedUntil(bob, 0), 0);

        // Thirty one days on, the same lock no longer covers another 90 days.
        vm.warp(START + 31 * DAY);
        assertEq(locker.lockedUntil(alice, _now() + 90 * DAY), 0);
        assertEq(locker.lockedUntil(alice, _now() + 89 * DAY), 100e18);

        vm.prank(alice);
        locker.extend(_now() + 90 * DAY);
        assertEq(locker.lockedUntil(alice, _now() + 90 * DAY), 100e18);

        // It only compares times: asked about the past it still counts a lock that is over.
        vm.warp(START + 400 * DAY);
        assertEq(locker.lockedOf(alice), 0);
        assertEq(locker.lockedUntil(alice, uint64(START + 100 * DAY)), 100e18);
        assertEq(locker.lockedUntil(alice, _now()), 0);
        vm.prank(alice);
        locker.withdraw();
        assertEq(locker.lockedUntil(alice, uint64(START + 100 * DAY)), 0, "and nothing once withdrawn");
        assertEq(locker.lockedUntil(alice, 0), 0);
    }

    // ---- awkward tokens ----

    function test_a_token_that_returns_false_locks_nothing() public {
        lux.setMode(MockLux.Mode.False, 0);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.TransferFailed.selector);
        locker.lock(100e18, _now() + 30 * DAY);
        assertEq(_amount(alice), 0);
        assertEq(locker.totalLocked(), 0);
    }

    function test_a_token_that_returns_false_on_the_way_out_leaves_the_position_in_place() public {
        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);
        vm.warp(until);
        lux.setMode(MockLux.Mode.False, 0);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.TransferFailed.selector);
        locker.withdraw();
        assertEq(_amount(alice), 100e18, "nothing was written off");
        assertEq(locker.totalLocked(), 100e18);

        lux.setMode(MockLux.Mode.Plain, 0);
        vm.prank(alice);
        locker.withdraw();
        assertEq(lux.balanceOf(alice), 1_000_000e18);
    }

    function test_a_token_that_returns_nothing_works() public {
        lux.setMode(MockLux.Mode.NoReturn, 0);
        uint64 until = _now() + 30 * DAY;
        _lock(alice, 100e18, until);
        assertEq(_amount(alice), 100e18);
        vm.warp(until);
        vm.prank(alice);
        locker.withdraw();
        assertEq(lux.balanceOf(alice), 1_000_000e18);
        assertEq(lux.balanceOf(address(locker)), 0);
    }

    function test_a_token_that_keeps_a_fee_is_credited_by_what_arrived() public {
        lux.setMode(MockLux.Mode.Fee, 100); // 1%
        uint64 until = _now() + 30 * DAY;
        vm.expectEmit(true, true, true, true, address(locker));
        emit Locked(alice, 99e18, 99e18, until);
        vm.prank(alice);
        assertEq(locker.lock(100e18, until), 99e18);
        assertEq(_amount(alice), 99e18, "not the 100 that was asked for");
        assertEq(locker.totalLocked(), 99e18);
        assertEq(lux.balanceOf(address(locker)), 99e18);

        _lock(bob, 200e18, until);
        assertEq(_amount(bob), 198e18);
        assertEq(lux.balanceOf(address(locker)), locker.totalLocked(), "every position is fully backed");

        // Both can get out: neither is short because of the other.
        vm.warp(until);
        vm.prank(alice);
        assertEq(locker.withdraw(), 99e18);
        vm.prank(bob);
        assertEq(locker.withdraw(), 198e18);
        assertEq(lux.balanceOf(address(locker)), 0);
        assertEq(locker.totalLocked(), 0);
    }

    function test_a_token_that_delivers_nothing_at_all_locks_nothing() public {
        lux.setMode(MockLux.Mode.Fee, 10_000);
        vm.prank(alice);
        vm.expectRevert(LuxLocker.ZeroAmount.selector);
        locker.lock(100e18, _now() + 30 * DAY);
        assertEq(_unlockAt(alice), 0);
    }

    function test_tokens_sent_straight_to_the_locker_are_nobodys_position() public {
        _lock(alice, 100e18, _now() + 30 * DAY);
        vm.prank(mallory);
        lux.transfer(address(locker), 500e18);
        assertEq(_amount(alice), 100e18);
        assertEq(_amount(mallory), 0);
        assertEq(locker.totalLocked(), 100e18);
        // And they do not ride along with the next deposit.
        _lock(bob, 10e18, _now() + 30 * DAY);
        assertEq(_amount(bob), 10e18);
        vm.warp(START + 30 * DAY);
        vm.prank(alice);
        assertEq(locker.withdraw(), 100e18);
        vm.prank(mallory);
        vm.expectRevert(LuxLocker.NothingLocked.selector);
        locker.withdraw();
    }

    // ---- reentrancy ----

    function test_the_token_cannot_get_back_in_during_a_deposit() public {
        bytes[3] memory calls = [
            abi.encodeCall(LuxLocker.lock, (1e18, _now() + 30 * DAY)),
            abi.encodeCall(LuxLocker.extend, (_now() + 60 * DAY)),
            abi.encodeCall(LuxLocker.withdraw, ())
        ];
        for (uint256 i; i < calls.length; ++i) {
            uint256 snap = vm.snapshotState();
            lux.arm(address(locker), calls[i]);
            _lock(alice, 100e18, _now() + 30 * DAY);
            assertTrue(lux.hookRan(), "the token did call back");
            assertFalse(lux.hookOk(), "and was refused");
            assertEq(bytes4(lux.hookResult()), LuxLocker.Reentrancy.selector);
            assertEq(_amount(alice), 100e18);
            assertEq(locker.totalLocked(), 100e18);
            assertEq(lux.balanceOf(address(locker)), 100e18);
            vm.revertToState(snap);
        }
    }

    function test_a_holder_who_tries_to_withdraw_again_inside_its_own_withdrawal_gets_one_position() public {
        Reenterer r = new Reenterer(locker, lux);
        lux.mint(address(r), 100e18);
        uint64 until = _now() + 30 * DAY;
        r.lock(100e18, until);
        _lock(alice, 300e18, until); // tokens worth stealing
        vm.warp(until);

        lux.arm(address(r), abi.encodeCall(Reenterer.again, ()));
        r.withdraw();
        assertTrue(r.againRan(), "it did try");
        assertFalse(r.againOk());
        assertEq(bytes4(r.againResult()), LuxLocker.Reentrancy.selector);
        assertEq(lux.balanceOf(address(r)), 100e18, "paid once");
        assertEq(lux.balanceOf(address(locker)), 300e18);
        assertEq(locker.totalLocked(), 300e18);

        // Afterwards, in a call of its own, there is nothing left to take.
        r.again();
        assertFalse(r.againOk());
        assertEq(bytes4(r.againResult()), LuxLocker.NothingLocked.selector);
    }

    function test_the_views_never_overstate_a_position_in_the_middle_of_a_call() public {
        // During a deposit the tokens have arrived and the position is not yet written.
        lux.arm(address(locker), abi.encodeCall(LuxLocker.lockedOf, (alice)));
        _lock(alice, 100e18, _now() + 30 * DAY);
        assertTrue(lux.hookOk());
        assertEq(abi.decode(lux.hookResult(), (uint256)), 0);

        // During a withdrawal the position is already gone.
        vm.warp(START + 30 * DAY);
        lux.arm(address(locker), abi.encodeWithSignature("totalLocked()"));
        vm.prank(alice);
        locker.withdraw();
        assertTrue(lux.hookOk());
        assertEq(abi.decode(lux.hookResult(), (uint256)), 0);
    }

    // ---- fuzz ----

    function testFuzz_lock_credits_exactly_what_arrives(uint256 amount, uint64 dur, uint16 fee) public {
        amount = bound(amount, 1, 1_000_000e18);
        dur = uint64(bound(dur, 7 * DAY, 730 * DAY));
        fee = uint16(bound(fee, 0, 9_999));
        if (fee != 0) lux.setMode(MockLux.Mode.Fee, fee);
        uint256 expected = amount - (amount * fee) / 10_000;
        vm.assume(expected != 0);

        _lock(alice, amount, _now() + dur);
        assertEq(_amount(alice), expected);
        assertEq(_unlockAt(alice), _now() + dur);
        assertEq(locker.totalLocked(), expected);
        assertEq(lux.balanceOf(address(locker)), expected);
        assertEq(locker.lockedOf(alice), expected);
    }

    function testFuzz_lock_length_bounds(uint64 unlockAt) public {
        bool tooShort = unlockAt < block.timestamp + 7 days;
        bool tooLong = unlockAt > block.timestamp + 730 days;
        vm.prank(alice);
        if (tooShort) vm.expectRevert(LuxLocker.LockTooShort.selector);
        else if (tooLong) vm.expectRevert(LuxLocker.LockTooLong.selector);
        locker.lock(1e18, unlockAt);
        if (!tooShort && !tooLong) assertEq(_unlockAt(alice), unlockAt);
        else assertEq(_amount(alice), 0);
    }

    function testFuzz_adding_never_shortens_and_withdraw_opens_exactly_at_unlock(
        uint256 a1,
        uint256 a2,
        uint64 d1,
        uint64 wait,
        uint64 d2,
        uint64 early
    ) public {
        a1 = bound(a1, 1, 400_000e18);
        a2 = bound(a2, 1, 400_000e18);
        d1 = uint64(bound(d1, 7 * DAY, 730 * DAY));
        wait = uint64(bound(wait, 0, 800 * DAY));
        d2 = uint64(bound(d2, 0, 800 * DAY));

        uint64 first = _now() + d1;
        _lock(alice, a1, first);
        vm.warp(block.timestamp + wait);
        uint64 second = _now() + d2;

        vm.prank(alice);
        (bool ok,) = address(locker).call(abi.encodeCall(LuxLocker.lock, (a2, second)));
        bool allowed = d2 >= 7 * DAY && d2 <= 730 * DAY && second >= first;
        assertEq(ok, allowed, "added exactly when the rules allow");

        uint64 unlockAt = _unlockAt(alice);
        uint256 total = ok ? a1 + a2 : a1;
        assertEq(_amount(alice), total);
        assertEq(unlockAt, ok ? second : first);
        assertGe(unlockAt, first, "never earlier than it was");
        assertEq(lux.balanceOf(address(locker)), total);
        assertEq(locker.totalLocked(), total);

        if (unlockAt > block.timestamp) {
            early = uint64(bound(early, block.timestamp, unlockAt - 1));
            vm.warp(early);
            assertEq(locker.lockedOf(alice), total);
            vm.prank(alice);
            vm.expectRevert(LuxLocker.StillLocked.selector);
            locker.withdraw();
            vm.warp(unlockAt);
        }
        assertEq(locker.lockedOf(alice), 0);
        vm.prank(alice);
        assertEq(locker.withdraw(), total);
        assertEq(lux.balanceOf(alice), 1_000_000e18);
        assertEq(lux.balanceOf(address(locker)), 0);
        assertEq(locker.totalLocked(), 0);
    }

    function testFuzz_extend_only_ever_moves_later(uint64 d1, uint64 wait, uint64 to) public {
        d1 = uint64(bound(d1, 7 * DAY, 730 * DAY));
        wait = uint64(bound(wait, 0, 800 * DAY));
        uint64 first = _now() + d1;
        _lock(alice, 10e18, first);
        vm.warp(block.timestamp + wait);

        vm.prank(alice);
        (bool ok,) = address(locker).call(abi.encodeCall(LuxLocker.extend, (to)));
        bool allowed = to > first && to > block.timestamp && to <= block.timestamp + 730 days;
        assertEq(ok, allowed);
        assertEq(_unlockAt(alice), ok ? to : first);
        assertGe(_unlockAt(alice), first);
        assertEq(_amount(alice), 10e18);
    }

    function testFuzz_lockedUntil_and_lockedOf(uint64 d1, uint64 wait, uint64 time) public {
        d1 = uint64(bound(d1, 7 * DAY, 730 * DAY));
        wait = uint64(bound(wait, 0, 800 * DAY));
        uint64 unlockAt = _now() + d1;
        _lock(alice, 10e18, unlockAt);
        vm.warp(block.timestamp + wait);
        assertEq(locker.lockedUntil(alice, time), time <= unlockAt ? 10e18 : 0);
        assertEq(locker.lockedOf(alice), block.timestamp < unlockAt ? 10e18 : 0);
        // Asked about now or later, lockedUntil never counts more than lockedOf does,
        // save in the one second the lock ends.
        if (time > block.timestamp) assertLe(locker.lockedUntil(alice, time), locker.lockedOf(alice));
    }
}

/// Several wallets locking, adding, extending, withdrawing and waiting in any order.
contract LockerHandler is Test {
    MockLux public lux;
    LuxLocker public locker;
    address[] public actors;

    mapping(address => uint256) public ghostAmount; // what each wallet should have in
    mapping(address => uint64) public ghostUnlockAt;
    uint256 public ghostIn; // all that ever arrived through lock
    uint256 public ghostOut; // all that ever left through withdraw
    uint256 public locks;
    uint256 public withdrawals;
    uint256 public refusedEarly;

    constructor(MockLux lux_, LuxLocker locker_) {
        lux = lux_;
        locker = locker_;
        for (uint256 i; i < 5; ++i) {
            address a = makeAddr(string(abi.encodePacked("locker actor ", vm.toString(i))));
            actors.push(a);
            lux.mint(a, 1_000_000e18);
            vm.prank(a);
            lux.approve(address(locker), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    function lock(uint256 seed, uint256 amount, uint64 dur) external {
        address a = _actor(seed);
        uint256 bal = lux.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        dur = uint64(bound(dur, 7 days, 730 days));
        uint64 unlockAt = uint64(block.timestamp) + dur;
        (, uint64 was) = locker.locked(a);
        if (unlockAt < was) unlockAt = was; // keep the present time
        vm.prank(a);
        uint256 got = locker.lock(amount, unlockAt);
        assertEq(got, amount);
        ghostAmount[a] += amount;
        ghostUnlockAt[a] = unlockAt;
        ghostIn += amount;
        ++locks;
    }

    /// Any time at all: most are refused, and a refusal must change nothing.
    function lockAnyTime(uint256 seed, uint256 amount, uint64 unlockAt) external {
        address a = _actor(seed);
        uint256 bal = lux.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        (, uint64 was) = locker.locked(a);
        bool allowed = unlockAt >= block.timestamp + 7 days && unlockAt <= block.timestamp + 730 days && unlockAt >= was;
        vm.prank(a);
        (bool ok,) = address(locker).call(abi.encodeCall(LuxLocker.lock, (amount, unlockAt)));
        assertEq(ok, allowed, "a lock goes through exactly when the rules allow");
        if (!ok) return;
        ghostAmount[a] += amount;
        ghostUnlockAt[a] = unlockAt;
        ghostIn += amount;
        ++locks;
    }

    function extend(uint256 seed, uint64 unlockAt) external {
        address a = _actor(seed);
        (uint256 amount, uint64 was) = locker.locked(a);
        unlockAt = uint64(bound(unlockAt, block.timestamp - 30 days, block.timestamp + 800 days));
        bool allowed =
            amount != 0 && unlockAt > was && unlockAt > block.timestamp && unlockAt <= block.timestamp + 730 days;
        vm.prank(a);
        (bool ok,) = address(locker).call(abi.encodeCall(LuxLocker.extend, (unlockAt)));
        assertEq(ok, allowed, "an extension goes through exactly when the rules allow");
        if (ok) ghostUnlockAt[a] = unlockAt;
    }

    function withdraw(uint256 seed) external {
        address a = _actor(seed);
        (uint256 amount, uint64 unlockAt) = locker.locked(a);
        uint256 before = lux.balanceOf(a);
        vm.prank(a);
        (bool ok,) = address(locker).call(abi.encodeCall(LuxLocker.withdraw, ()));
        assertEq(ok, amount != 0 && block.timestamp >= unlockAt, "out exactly when unlocked");
        if (!ok) {
            if (amount != 0) ++refusedEarly;
            assertEq(lux.balanceOf(a), before);
            return;
        }
        assertEq(lux.balanceOf(a) - before, amount, "the whole position, to its owner");
        ghostAmount[a] = 0;
        ghostUnlockAt[a] = 0;
        ghostOut += amount;
        ++withdrawals;
    }

    function wait(uint64 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 200 days));
    }
}

contract LuxLockerInvariantTest is Test {
    MockLux lux;
    LuxLocker locker;
    LockerHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        lux = new MockLux();
        locker = new LuxLocker(address(lux));
        handler = new LockerHandler(lux, locker);
        targetContract(address(handler));
    }

    function invariant_1_the_lockers_balance_is_the_sum_of_positions() public view {
        uint256 sum;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            (uint256 amount,) = locker.locked(handler.actors(i));
            sum += amount;
        }
        assertEq(lux.balanceOf(address(locker)), sum, "balance equals the sum of positions");
        assertEq(locker.totalLocked(), sum, "and so does the running total");
    }

    function invariant_2_every_position_is_what_its_owner_put_in() public view {
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            address a = handler.actors(i);
            (uint256 amount, uint64 unlockAt) = locker.locked(a);
            assertEq(amount, handler.ghostAmount(a));
            assertEq(unlockAt, handler.ghostUnlockAt(a));
            assertEq(locker.lockedOf(a), block.timestamp < unlockAt ? amount : 0);
            assertEq(lux.balanceOf(a) + amount, 1_000_000e18, "nobody gained or lost a token");
        }
    }

    function invariant_3_what_is_held_is_what_came_in_less_what_went_out() public view {
        assertEq(lux.balanceOf(address(locker)), handler.ghostIn() - handler.ghostOut());
    }

    function invariant_4_no_position_runs_past_two_years() public view {
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            (, uint64 unlockAt) = locker.locked(handler.actors(i));
            assertLe(unlockAt, block.timestamp + 730 days);
        }
    }
}
