// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice Simple fixed-supply ERC-20 for faucet distribution.
///         All tokens are minted to the deployer at construction time.
contract TestToken is ERC20 {
    /// @param name_          Token name
    /// @param symbol_        Token symbol
    /// @param initialSupply_ Total supply in smallest unit (18 decimals)
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply_
    ) ERC20(name_, symbol_) {
        _mint(msg.sender, initialSupply_);
    }
}
