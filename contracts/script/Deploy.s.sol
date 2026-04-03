// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {TestToken} from "../src/TestToken.sol";
import {Faucet} from "../src/Faucet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Deploy is Script {
    // ── Sepolia 기본값 ────────────────────────────────────────────
    uint256 constant INITIAL_SUPPLY = 1_000_000e18;
    uint256 constant FAUCET_SEED    = 10_000e18;
    uint256 constant DRIP_AMOUNT    = 10e18;
    uint64  constant COOLDOWN       = 86400;     // 24시간
    uint256 constant EPOCH_BUDGET   = 100e18;
    uint64  constant EPOCH_DURATION = 86400;     // 24시간

    function run() external {
        // 배포자 키 (--private-key 또는 환경변수에서)
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin       = vm.envAddress("ADMIN_ADDRESS");
        address pauser      = vm.envAddress("PAUSER_ADDRESS");
        address relayer     = vm.envAddress("RELAYER_ADDRESS");

        vm.startBroadcast(deployerKey);

        // 1. TestToken 배포
        TestToken token = new TestToken("Test Token", "TTK", INITIAL_SUPPLY);
        console.log("TestToken deployed:", address(token));

        // 2. Faucet 배포
        Faucet faucet = new Faucet(
            admin,
            pauser,
            relayer,
            IERC20(address(token)),
            DRIP_AMOUNT,
            COOLDOWN,
            EPOCH_BUDGET,
            EPOCH_DURATION
        );
        console.log("Faucet deployed:", address(faucet));

        // 3. Faucet에 토큰 시드 주입
        token.transfer(address(faucet), FAUCET_SEED);
        console.log("Seeded faucet with", FAUCET_SEED / 1e18, "TTK");

        vm.stopBroadcast();

        // 배포 후 설정해야 할 환경변수 출력
        console.log("\n=== Set these in your .env ===");
        console.log("FAUCET_ADDRESS=", address(faucet));
        console.log("TOKEN_ADDRESS=", address(token));
    }
}
