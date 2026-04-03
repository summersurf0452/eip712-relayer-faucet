"use client";

import { Suspense, useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import * as THREE from "three";

/** Dark glass material — appears transparent with bright reflections on dark bg */
function useGlassMaterial() {
  return useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color("#2a2a3a"),
        metalness: 0.6,
        roughness: 0.08,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        transmission: 0.85,
        thickness: 2.0,
        ior: 1.5,
        envMapIntensity: 4,
        reflectivity: 1.0,
        transparent: true,
      }),
    []
  );
}

/** Brighter glass for accent pieces */
function useAccentGlassMaterial() {
  return useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color("#1a1028"),
        metalness: 0.05,
        roughness: 0.02,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        transmission: 0.95,
        thickness: 2.0,
        ior: 1.5,
        envMapIntensity: 4,
        transparent: true,
      }),
    []
  );
}

function GlassKnot() {
  const groupRef = useRef<THREE.Group>(null!);
  const glass = useGlassMaterial();

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    groupRef.current.rotation.y = t * 0.08;
    groupRef.current.rotation.x = Math.sin(t * 0.06) * 0.12;
  });

  return (
    <group ref={groupRef}>
      {/* Primary — trefoil knot (the hero shape) */}
      <mesh material={glass}>
        <torusKnotGeometry args={[1.3, 0.38, 256, 48, 2, 3]} />
      </mesh>

      {/* Secondary — large torus ring at an angle */}
      <mesh material={glass} rotation={[Math.PI / 3, Math.PI / 5, 0]}>
        <torusGeometry args={[1.8, 0.2, 48, 128]} />
      </mesh>

      {/* Main orbit — large bright white/gold streak */}
      <mesh rotation={[Math.PI / 2 + 0.15, 0.3, -0.1]}>
        <torusGeometry args={[2.2, 0.025, 8, 192]} />
        <meshBasicMaterial color="#fff8e0" transparent opacity={0.85} toneMapped={false} />
      </mesh>
      <mesh rotation={[Math.PI / 2 + 0.15 + Math.PI / 6, 0.3, -0.1]}>
        <torusGeometry args={[2.2, 0.012, 8, 192]} />
        <meshBasicMaterial color="#fff8e0" transparent opacity={0.45} toneMapped={false} />
      </mesh>

      {/* Neon light streaks passing through the glass */}
      <mesh rotation={[0.3, 0.5, 0.1]}>
        <torusGeometry args={[1.4, 0.015, 8, 128]} />
        <meshBasicMaterial color="#a855f7" transparent opacity={0.7} toneMapped={false} />
      </mesh>
      <mesh rotation={[1.2, 0.2, -0.3]}>
        <torusGeometry args={[1.1, 0.012, 8, 128]} />
        <meshBasicMaterial color="#c084fc" transparent opacity={0.5} toneMapped={false} />
      </mesh>
      <mesh rotation={[-0.4, 1.0, 0.6]}>
        <torusGeometry args={[1.6, 0.01, 8, 128]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.4} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Upper-left accent — small icosahedron, slow drift */
function AccentUpperLeft() {
  const ref = useRef<THREE.Mesh>(null!);
  const glass = useAccentGlassMaterial();

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    ref.current.rotation.y = t * 0.15;
    ref.current.rotation.z = t * 0.1;
    ref.current.position.y = -2.6 + Math.sin(t * 0.4) * 0.08;
  });

  return (
    <mesh ref={ref} material={glass} position={[-3.2, -2.6, -1.5]}>
      <icosahedronGeometry args={[0.35, 1]} />
    </mesh>
  );
}


export default function Scene3D() {
  return (
    <Canvas
      aria-hidden
      camera={{ position: [0, 0, 6.1], fov: 42 }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}
      style={{ background: "transparent" }}
    >

      {/* Dramatic lighting */}
      <ambientLight intensity={0.15} />
      <directionalLight position={[5, 5, 5]} intensity={1.5} color="#ffffff" />

      {/* Purple/violet accent lights */}
      <pointLight position={[-2, 2, 3]} intensity={3} color="#9333ea" distance={10} />
      <pointLight position={[3, -1, 2]} intensity={2} color="#7c3aed" distance={10} />
      <pointLight position={[0, -3, 1]} intensity={1.5} color="#a855f7" distance={8} />

      {/* Cyan accent for contrast */}
      <pointLight position={[2, 3, -2]} intensity={1} color="#22d3ee" distance={8} />

      <Suspense fallback={null}>
        <Environment files="/envmap/dikhololo_night_1k.hdr" />
        <GlassKnot />
        <AccentUpperLeft />
      </Suspense>
    </Canvas>
  );
}
