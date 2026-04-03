// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Faucet
/// @notice Holds tokens and dispenses them via relayer-only drip()
///         with cooldown, requestId idempotency, pause, and epoch budget.
contract Faucet is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────── Roles ────────────────────
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ──────────────────── Immutable config ────────────────────
    IERC20 public immutable token;
    uint256 public immutable dripAmount;
    uint64 public immutable cooldown;
    uint256 public immutable epochBudget;
    uint64 public immutable epochDuration;

    // ──────────────────── Mutable state ────────────────────
    mapping(address => uint64) public nextClaimAt;
    mapping(bytes32 => bool) public processedRequestIds;
    uint64 public epochStart;
    uint256 public epochSpent;

    // ──────────────────── Errors ────────────────────
    error ZeroAddress();
    error CooldownActive(uint64 nextClaimAt);
    error RequestAlreadyProcessed(bytes32 requestId);
    error InsufficientFaucetBalance(uint256 balance, uint256 needed);
    error EpochBudgetExceeded(uint256 remaining, uint256 needed);

    // ──────────────────── Events ────────────────────
    event Dripped(
        bytes32 indexed requestId,
        address indexed recipient,
        uint256 amount,
        address indexed relayer,
        uint64 nextClaimAt,
        uint64 epochStart,
        uint256 epochSpent
    );

    event EmergencyWithdrawal(address indexed to, uint256 amount);

    // ──────────────────── Constructor ────────────────────
    constructor(
        address admin,
        address pauser,
        address relayer,
        IERC20 token_,
        uint256 dripAmount_,
        uint64 cooldown_,
        uint256 epochBudget_,
        uint64 epochDuration_
    ) {
        if (admin == address(0)) revert ZeroAddress();
        if (pauser == address(0)) revert ZeroAddress();
        if (relayer == address(0)) revert ZeroAddress();
        if (address(token_) == address(0)) revert ZeroAddress();
        require(dripAmount_ > 0, "dripAmount must be > 0");
        require(epochBudget_ >= dripAmount_, "epochBudget must be >= dripAmount");
        require(epochDuration_ > 0, "epochDuration must be > 0");

        // Assign roles
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(RELAYER_ROLE, relayer);

        // Set immutable config
        token = token_;
        dripAmount = dripAmount_;
        cooldown = cooldown_;
        epochBudget = epochBudget_;
        epochDuration = epochDuration_;

        // Initialize first epoch
        epochStart = uint64(block.timestamp);
    }

    // ──────────────────── Core: drip ────────────────────
    function drip(address recipient, bytes32 requestId)
        external
        onlyRole(RELAYER_ROLE)
        whenNotPaused
        nonReentrant
    {
        // 1. Zero address check
        if (recipient == address(0)) revert ZeroAddress();

        // 2. Duplicate requestId check
        if (processedRequestIds[requestId]) revert RequestAlreadyProcessed(requestId);

        // 3. Cooldown check
        if (block.timestamp < nextClaimAt[recipient]) {
            revert CooldownActive(nextClaimAt[recipient]);
        }

        // 4. Epoch rollover
        if (block.timestamp >= epochStart + epochDuration) {
            epochStart = uint64(block.timestamp);
            epochSpent = 0;
        }

        // 5. Epoch budget check
        if (epochSpent + dripAmount > epochBudget) {
            revert EpochBudgetExceeded(epochBudget - epochSpent, dripAmount);
        }

        // 6. Balance check
        uint256 balance = token.balanceOf(address(this));
        if (balance < dripAmount) {
            revert InsufficientFaucetBalance(balance, dripAmount);
        }

        // Effects
        processedRequestIds[requestId] = true;
        uint64 newNextClaimAt = uint64(block.timestamp) + cooldown;
        nextClaimAt[recipient] = newNextClaimAt;
        epochSpent += dripAmount;

        // Interaction
        token.safeTransfer(recipient, dripAmount);

        emit Dripped(
            requestId,
            recipient,
            dripAmount,
            msg.sender,
            newNextClaimAt,
            epochStart,
            epochSpent
        );
    }

    // ──────────────────── Pause controls ────────────────────
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ──────────────────── Emergency ────────────────────
    function emergencyWithdraw(address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
    {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit EmergencyWithdrawal(to, amount);
    }
}
