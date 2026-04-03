// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {TestToken} from "../src/TestToken.sol";
import {Faucet} from "../src/Faucet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FaucetTest is Test {
    // ──────────────── 등장인물 ────────────────
    address admin   = makeAddr("admin");
    address pauser  = makeAddr("pauser");
    address relayer = makeAddr("relayer");
    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");

    // ──────────────── 컨트랙트 ────────────────
    TestToken token;
    Faucet faucet;

    // ──────────────── 설정값 (Local/Anvil 기준) ────────────────
    uint256 constant INITIAL_SUPPLY = 1_000_000e18;
    uint256 constant FAUCET_SEED    = 10_000e18;
    uint256 constant DRIP_AMOUNT    = 10e18;
    uint64  constant COOLDOWN       = 300;       // 5분
    uint256 constant EPOCH_BUDGET   = 100e18;
    uint64  constant EPOCH_DURATION = 3600;      // 1시간

    // ──────────────── setUp: 매 테스트 전에 실행 ────────────────
    function setUp() public {
        // 1. admin이 토큰 배포 → admin이 1,000,000개 보유
        vm.startPrank(admin);
        token = new TestToken("Test Token", "TTK", INITIAL_SUPPLY);

        // 2. Faucet 배포
        faucet = new Faucet(
            admin,
            pauser,
            relayer,
            IERC20(address(token)),
            DRIP_AMOUNT,
            COOLDOWN,
            EPOCH_BUDGET,
            EPOCH_DURATION
        );

        // 3. Faucet에 토큰 시드 주입
        token.transfer(address(faucet), FAUCET_SEED);
        vm.stopPrank();
    }

    // ================================================================
    //  정상 동작 테스트
    // ================================================================

    /// @notice relayer가 drip 호출하면 recipient에게 토큰이 간다
    function test_drip_success() public {
        bytes32 requestId = keccak256("request-1");

        // relayer가 drip 호출
        vm.prank(relayer);
        faucet.drip(alice, requestId);

        // alice가 10토큰 받았는지 확인
        assertEq(token.balanceOf(alice), DRIP_AMOUNT);

        // Faucet 잔액이 줄었는지 확인
        assertEq(token.balanceOf(address(faucet)), FAUCET_SEED - DRIP_AMOUNT);

        // requestId가 처리됨으로 기록됐는지 확인
        assertTrue(faucet.processedRequestIds(requestId));
    }

    // ================================================================
    //  관문 1: relayer만 호출 가능
    // ================================================================

    /// @notice relayer가 아닌 사람이 drip 호출하면 실패
    function test_drip_reverts_when_not_relayer() public {
        bytes32 requestId = keccak256("request-1");

        // alice가 직접 drip 호출 시도
        vm.prank(alice);
        vm.expectRevert(); // AccessControl 에러
        faucet.drip(alice, requestId);
    }

    // ================================================================
    //  관문 2: 중복 requestId 방지
    // ================================================================

    /// @notice 같은 requestId로 두 번 호출하면 두 번째가 실패
    function test_drip_reverts_on_duplicate_requestId() public {
        bytes32 requestId = keccak256("request-1");

        // 첫 번째: 성공
        vm.prank(relayer);
        faucet.drip(alice, requestId);

        // 두 번째: 같은 requestId로 다른 주소에 시도 → 실패
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(Faucet.RequestAlreadyProcessed.selector, requestId)
        );
        faucet.drip(bob, requestId);
    }

    // ================================================================
    //  관문 3: cooldown
    // ================================================================

    /// @notice 같은 주소가 cooldown 내에 다시 요청하면 실패
    function test_drip_reverts_on_cooldown() public {
        // 첫 번째 지급
        vm.prank(relayer);
        faucet.drip(alice, keccak256("req-1"));

        // 1분 후 다시 시도 (cooldown 5분)
        vm.warp(block.timestamp + 60);

        vm.prank(relayer);
        vm.expectRevert(); // CooldownActive
        faucet.drip(alice, keccak256("req-2"));
    }

    /// @notice cooldown이 지나면 다시 받을 수 있다
    function test_drip_succeeds_after_cooldown() public {
        vm.prank(relayer);
        faucet.drip(alice, keccak256("req-1"));

        // cooldown만큼 시간 경과
        vm.warp(block.timestamp + COOLDOWN);

        vm.prank(relayer);
        faucet.drip(alice, keccak256("req-2"));

        // 두 번 받았으니 20토큰
        assertEq(token.balanceOf(alice), DRIP_AMOUNT * 2);
    }

    // ================================================================
    //  관문 4+5: epoch budget
    // ================================================================

    /// @notice epoch 예산을 초과하면 실패
    function test_drip_reverts_on_epoch_budget_exceeded() public {
        // 100e18 / 10e18 = 10번까지 가능
        for (uint256 i = 0; i < 10; i++) {
            address recipient = makeAddr(string(abi.encodePacked("user-", vm.toString(i))));
            vm.prank(relayer);
            faucet.drip(recipient, keccak256(abi.encodePacked("req-", vm.toString(i))));
        }

        // 11번째: epoch budget 초과
        address extraUser = makeAddr("extra");
        vm.prank(relayer);
        vm.expectRevert(); // EpochBudgetExceeded
        faucet.drip(extraUser, keccak256("req-extra"));
    }

    /// @notice epoch 시간이 지나면 budget이 리셋된다
    function test_drip_succeeds_after_epoch_rollover() public {
        // 10번 지급으로 budget 소진
        for (uint256 i = 0; i < 10; i++) {
            address recipient = makeAddr(string(abi.encodePacked("user-", vm.toString(i))));
            vm.prank(relayer);
            faucet.drip(recipient, keccak256(abi.encodePacked("req-", vm.toString(i))));
        }

        // epoch 시간 경과
        vm.warp(block.timestamp + EPOCH_DURATION);

        // 다시 지급 가능
        address newUser = makeAddr("new-user");
        vm.prank(relayer);
        faucet.drip(newUser, keccak256("req-new"));

        assertEq(token.balanceOf(newUser), DRIP_AMOUNT);
    }

    // ================================================================
    //  관문 6: 잔액 부족
    // ================================================================

    /// @notice Faucet에 토큰이 없으면 실패
    function test_drip_reverts_on_insufficient_balance() public {
        // admin이 Faucet의 토큰을 전부 회수
        vm.prank(pauser);
        faucet.pause();
        vm.prank(admin);
        faucet.emergencyWithdraw(admin, FAUCET_SEED);

        // unpause 후 drip 시도
        vm.prank(pauser);
        faucet.unpause();

        vm.prank(relayer);
        vm.expectRevert(); // InsufficientFaucetBalance
        faucet.drip(alice, keccak256("req-1"));
    }

    // ================================================================
    //  pause / unpause
    // ================================================================

    /// @notice paused 상태에서 drip 실패
    function test_drip_reverts_when_paused() public {
        vm.prank(pauser);
        faucet.pause();

        vm.prank(relayer);
        vm.expectRevert(); // EnforcedPause
        faucet.drip(alice, keccak256("req-1"));
    }

    /// @notice pauser가 아닌 사람은 pause 불가
    function test_pause_reverts_when_not_pauser() public {
        vm.prank(alice);
        vm.expectRevert(); // AccessControl
        faucet.pause();
    }

    // ================================================================
    //  emergencyWithdraw
    // ================================================================

    /// @notice admin이 paused 상태에서 토큰 회수 가능
    function test_emergencyWithdraw_success() public {
        vm.prank(pauser);
        faucet.pause();

        vm.prank(admin);
        faucet.emergencyWithdraw(admin, FAUCET_SEED);

        assertEq(token.balanceOf(admin), INITIAL_SUPPLY - FAUCET_SEED + FAUCET_SEED);
        assertEq(token.balanceOf(address(faucet)), 0);
    }

    /// @notice paused가 아니면 emergencyWithdraw 실패
    function test_emergencyWithdraw_reverts_when_not_paused() public {
        vm.prank(admin);
        vm.expectRevert(); // ExpectedPause
        faucet.emergencyWithdraw(admin, FAUCET_SEED);
    }

    /// @notice admin이 아니면 emergencyWithdraw 실패
    function test_emergencyWithdraw_reverts_when_not_admin() public {
        vm.prank(pauser);
        faucet.pause();

        vm.prank(relayer);
        vm.expectRevert(); // AccessControl
        faucet.emergencyWithdraw(relayer, FAUCET_SEED);
    }
}
