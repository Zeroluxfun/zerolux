// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title LuxLocker
/// @notice Holds $LUX that a wallet has chosen to lock until a time it names.
///         Other contracts and the product's backend read how much a wallet has
///         locked and until when, and decide from that what the wallet may do.
///
///         A wallet has one position: an amount and the time it unlocks.
///           lock(amount, unlockAt)  put tokens in, or add to what is there
///           extend(unlockAt)        push the unlock time out
///           withdraw()              after the unlock time, take all of it back
///         A lock runs at least seven days and at most two years from the
///         moment it is made or added to. The unlock time can be kept or moved
///         later, never earlier.
/// @dev    Nobody runs this contract. It has no owner, no pause, no fee and no
///         way to be changed, and the only call that sends tokens out sends a
///         position to the wallet that made it. Tokens sent here without `lock`
///         belong to no position and cannot be taken out by anyone.
///         A position is credited with what arrived, measured on the token's own
///         balance, so a token that keeps part of a transfer cannot make a
///         position larger than the tokens behind it. A token whose balances
///         change by themselves is not supported: positions would stop adding up
///         to what is held.
contract LuxLocker {
    uint64 public constant MIN_LOCK = 7 days;
    uint64 public constant MAX_LOCK = 730 days; // two years

    address public immutable token;

    struct Position {
        uint256 amount;
        uint64 unlockAt;
    }

    mapping(address account => Position) private _positions;
    uint256 public totalLocked; // the sum of every position
    uint256 private _lock = 1;

    event Locked(address indexed account, uint256 received, uint256 amount, uint64 unlockAt);
    event Extended(address indexed account, uint64 unlockAt);
    event Withdrawn(address indexed account, uint256 amount);

    error ZeroAddress();
    error NotAToken();
    error Reentrancy();
    error ZeroAmount();
    error LockTooShort();
    error LockTooLong();
    error CannotShorten();
    error NothingLocked();
    error StillLocked();
    error NotLater();
    error TransferFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_) {
        if (token_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert NotAToken();
        token = token_;
    }

    // ---- the locker's own calls ----

    /// @notice Lock `amount` of the caller's tokens until `unlockAt`, or add them
    ///         to the caller's position. The caller must have approved `amount`.
    ///         `unlockAt` must be between seven days and two years from now, and
    ///         no earlier than the position's present unlock time: adding to a
    ///         position that has less than seven days left, or that has already
    ///         unlocked, locks all of it again for at least seven days.
    ///         The position grows by what the contract received.
    function lock(uint256 amount, uint64 unlockAt) external nonReentrant returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        if (unlockAt < block.timestamp + MIN_LOCK) revert LockTooShort();
        if (unlockAt > block.timestamp + MAX_LOCK) revert LockTooLong();
        Position memory p = _positions[msg.sender];
        if (unlockAt < p.unlockAt) revert CannotShorten();

        // The amount credited is only known once the tokens are in, so the
        // transfer comes before the bookkeeping. The lock above covers it.
        uint256 before = _balance();
        _pull(msg.sender, amount);
        received = _balance() - before;
        if (received == 0) revert ZeroAmount();

        p.amount += received;
        p.unlockAt = unlockAt;
        _positions[msg.sender] = p;
        totalLocked += received;
        emit Locked(msg.sender, received, p.amount, unlockAt);
    }

    /// @notice Move the caller's unlock time later: past where it stands, in the
    ///         future, and at most two years from now.
    function extend(uint64 unlockAt) external nonReentrant {
        Position storage p = _positions[msg.sender];
        if (p.amount == 0) revert NothingLocked();
        if (unlockAt <= p.unlockAt || unlockAt <= block.timestamp) revert NotLater();
        if (unlockAt > block.timestamp + MAX_LOCK) revert LockTooLong();
        p.unlockAt = unlockAt;
        emit Extended(msg.sender, unlockAt);
    }

    /// @notice Once the unlock time has come, send the caller's whole position
    ///         back to the caller.
    function withdraw() external nonReentrant returns (uint256 amount) {
        Position memory p = _positions[msg.sender];
        amount = p.amount;
        if (amount == 0) revert NothingLocked();
        if (block.timestamp < p.unlockAt) revert StillLocked();
        delete _positions[msg.sender];
        totalLocked -= amount;
        _push(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---- views ----

    /// @notice The position as it is stored, expired or not.
    function locked(address account) external view returns (uint256 amount, uint64 unlockAt) {
        Position memory p = _positions[account];
        return (p.amount, p.unlockAt);
    }

    /// @notice What `account` has locked right now. A position that can be
    ///         withdrawn counts as nothing, whether or not it has been.
    function lockedOf(address account) external view returns (uint256) {
        Position memory p = _positions[account];
        return block.timestamp < p.unlockAt ? p.amount : 0;
    }

    /// @notice What `account` has in a position that unlocks at `time` or later.
    ///         Ask with a time ahead of now to learn whether tokens are locked
    ///         for at least that much longer.
    /// @dev    This compares the stored unlock time with `time` and nothing
    ///         else. Asked about a time that is not in the future it will count a
    ///         position that can already be withdrawn; use `lockedOf` for "now".
    function lockedUntil(address account, uint64 time) external view returns (uint256) {
        Position memory p = _positions[account];
        return p.unlockAt >= time ? p.amount : 0;
    }

    // ---- internals ----

    function _balance() private view returns (uint256) {
        // balanceOf(address)
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length != 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }

    function _pull(address from, uint256 amount) private {
        // transferFrom(address,address,uint256)
        _call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
    }

    function _push(address to, uint256 amount) private {
        // transfer(address,uint256)
        _call(abi.encodeWithSelector(0xa9059cbb, to, amount));
    }

    /// @dev A token may answer true or answer nothing. Anything else is a failure.
    function _call(bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || !(ret.length == 0 || (ret.length == 32 && abi.decode(ret, (uint256)) == 1))) {
            revert TransferFailed();
        }
    }
}
