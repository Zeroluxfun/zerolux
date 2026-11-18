// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {AgentWallet} from "./AgentWallet.sol";

/// @title ZeroLuxFactory
/// @notice Registers agents and deploys one wallet per agent. Holds the three
///         settings every wallet reads: who may meter runs (operator), where
///         run charges go (treasury) and the markup on a run's model cost.
/// @dev    This contract never holds money. Changing the treasury takes two
///         days in public, so a stolen owner key cannot redirect charges at
///         once; the operator can be replaced at once, because that is the key
///         most likely to leak.
contract ZeroLuxFactory {
    uint16 public constant MAX_MARKUP_BPS = 5_000; // 50%
    uint256 public constant TREASURY_DELAY = 2 days;

    address public immutable usdg;
    address public immutable walletImplementation;

    address public owner;
    address public pendingOwner;
    address public operator;
    address public treasury;
    address public pendingTreasury;
    uint256 public pendingTreasuryAt;
    uint16 public markupBps;

    struct Agent {
        address wallet;
        address creator;
        bytes32 specHash; // hash of the agent's published spec
        uint64 createdAt;
    }

    Agent[] private _agents;
    mapping(address wallet => uint256 idPlusOne) public agentIdOf;

    event AgentCreated(uint256 indexed id, address indexed wallet, address indexed creator, bytes32 specHash);
    event OperatorSet(address indexed operator);
    event MarkupSet(uint16 markupBps);
    event TreasuryProposed(address indexed treasury, uint256 effectiveAt);
    event TreasurySet(address indexed treasury);
    event OwnershipOffered(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error ZeroAddress();
    error MarkupTooHigh();
    error TooEarly();
    error NothingPending();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdg_, address owner_, address operator_, address treasury_, uint16 markupBps_) {
        if (usdg_ == address(0) || owner_ == address(0) || operator_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (markupBps_ > MAX_MARKUP_BPS) revert MarkupTooHigh();
        usdg = usdg_;
        owner = owner_;
        operator = operator_;
        treasury = treasury_;
        markupBps = markupBps_;
        walletImplementation = address(new AgentWallet());
        emit OwnershipTransferred(address(0), owner_);
        emit OperatorSet(operator_);
        emit TreasurySet(treasury_);
        emit MarkupSet(markupBps_);
    }

    /// @notice Anyone may put an agent on the line. `agentOwner` owns its wallet.
    function createAgent(address agentOwner, uint128 perRunCap, uint128 perDayCap, bytes32 specHash)
        external
        returns (uint256 id, address wallet)
    {
        id = _agents.length;
        wallet = _clone(walletImplementation, keccak256(abi.encode(msg.sender, id)));
        AgentWallet(wallet).init(agentOwner, perRunCap, perDayCap);
        _agents.push(Agent(wallet, msg.sender, specHash, uint64(block.timestamp)));
        agentIdOf[wallet] = id + 1;
        emit AgentCreated(id, wallet, msg.sender, specHash);
    }

    function agentCount() external view returns (uint256) {
        return _agents.length;
    }

    function agent(uint256 id) external view returns (Agent memory) {
        return _agents[id];
    }

    function isAgentWallet(address wallet) external view returns (bool) {
        return agentIdOf[wallet] != 0;
    }

    // ---- owner ----

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setMarkup(uint16 markupBps_) external onlyOwner {
        if (markupBps_ > MAX_MARKUP_BPS) revert MarkupTooHigh();
        markupBps = markupBps_;
        emit MarkupSet(markupBps_);
    }

    function proposeTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        pendingTreasury = treasury_;
        pendingTreasuryAt = block.timestamp + TREASURY_DELAY;
        emit TreasuryProposed(treasury_, pendingTreasuryAt);
    }

    function acceptTreasury() external onlyOwner {
        if (pendingTreasury == address(0)) revert NothingPending();
        if (block.timestamp < pendingTreasuryAt) revert TooEarly();
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        pendingTreasuryAt = 0;
        emit TreasurySet(treasury);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipOffered(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @dev EIP-1167 minimal proxy, created with CREATE2.
    function _clone(address implementation, bytes32 salt) private returns (address instance) {
        assembly ("memory-safe") {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create2(0, 0x09, 0x37, salt)
        }
        if (instance == address(0)) revert ZeroAddress();
    }
}
