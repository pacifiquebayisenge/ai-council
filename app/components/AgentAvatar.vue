<script setup lang="ts">
import * as THREE from "three";

const props = withDefaults(defineProps<{ member: string; state?: string; size?: "small" | "large" }>(), {
  state: "waiting",
  size: "large",
});
const host = ref<HTMLElement | null>(null);
let renderer: THREE.WebGLRenderer | undefined;
let frame = 0;
let observer: ResizeObserver | undefined;
let scene: THREE.Scene | undefined;
let camera: THREE.PerspectiveCamera | undefined;
let head: THREE.Group | undefined;
let leftEye: THREE.Group | undefined;
let rightEye: THREE.Group | undefined;
let leftLid: THREE.Mesh | undefined;
let rightLid: THREE.Mesh | undefined;
let mouth: THREE.Mesh | undefined;
let pupils: THREE.Group[] = [];
let brows: THREE.Mesh[] = [];
let time = 0;
let visible = true;
let reducedMotion = false;
const palette: Record<string, { skin: number; hair: number; shirt: number; backdrop: number; iris: number }> = {
  athena: { skin: 0xd7a185, hair: 0x293846, shirt: 0x526f87, backdrop: 0xe6eef5, iris: 0x496979 },
  plutus: { skin: 0xb97859, hair: 0x352728, shirt: 0xb18a54, backdrop: 0xf5ecdf, iris: 0x624a39 },
  solon: { skin: 0xe0ad92, hair: 0x272333, shirt: 0x75668e, backdrop: 0xeee9f5, iris: 0x4f566a },
  vera: { skin: 0x9c654e, hair: 0x202b2d, shirt: 0x9c706c, backdrop: 0xf5eae8, iris: 0x4c3a32 },
  guest: { skin: 0xc9987b, hair: 0x504038, shirt: 0x638f80, backdrop: 0xe7f2ed, iris: 0x5d5143 },
  chairman: { skin: 0xc9a48a, hair: 0x636b67, shirt: 0x6a8270, backdrop: 0xe7eee9, iris: 0x5d635d },
  user: { skin: 0xd0a58a, hair: 0x53473f, shirt: 0x888078, backdrop: 0xf0eee9, iris: 0x53473f },
};
function sphere(parent: THREE.Object3D, color: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, roughness = 0.9) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), new THREE.MeshStandardMaterial({ color, roughness }));
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}
function build() {
  if (!host.value || renderer) return;
  const p = palette[props.member] || palette.guest!;
  const width = Math.max(host.value.clientWidth, 32);
  const height = Math.max(host.value.clientHeight, 32);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(p.backdrop);
  camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
  camera.position.set(0, 0.16, 8.4);
  camera.lookAt(0, 0.05, 0);
  renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.6;
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.value.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb3a49b, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(-3, 5, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdce9ff, 1.4);
  fill.position.set(4, 1, 4);
  scene.add(fill);
  head = new THREE.Group();
  scene.add(head);
  sphere(head, p.shirt, 0, -1.62, -0.08, 1.42, 0.87, 0.8);
  sphere(head, p.skin, 0, -1.05, 0.13, 0.34, 0.49, 0.32);
  sphere(head, p.skin, 0, 0.06, 0, 0.89, 1.16, 0.75);
  sphere(head, p.skin, -0.87, -0.02, 0.01, 0.19, 0.3, 0.18);
  sphere(head, p.skin, 0.87, -0.02, 0.01, 0.19, 0.3, 0.18);
  // Distinctive hair silhouettes for each character.
  sphere(head, p.hair, 0, 0.92, -0.1, 0.94, 0.46, 0.76);
  const sidePart = props.member === "plutus" ? 0.19 : props.member === "solon" ? -0.14 : 0;
  sphere(head, p.hair, sidePart, 0.79, 0.43, 0.8, 0.28, 0.41);
  sphere(head, p.hair, -0.76, 0.49, -0.03, 0.19, props.member === "plutus" ? 0.84 : 0.54, 0.43);
  sphere(head, p.hair, 0.76, 0.49, -0.03, 0.19, props.member === "plutus" ? 0.84 : 0.54, 0.43);
  sphere(head, p.skin, 0, -0.24, 0.77, 0.18, 0.27, 0.18);
  pupils = [];
  for (const x of [-0.34, 0.34]) {
    const eye = new THREE.Group();
    eye.position.set(x, 0.16, 0.65);
    head.add(eye);
    sphere(eye, 0xfff9f0, 0, 0, 0, 0.22, 0.145, 0.13);
    const pupil = new THREE.Group();
    eye.add(pupil);
    sphere(pupil, p.iris, 0, 0, 0.119, 0.084, 0.091, 0.038);
    sphere(pupil, 0x1c2024, 0, 0, 0.15, 0.046, 0.058, 0.023);
    sphere(pupil, 0xffffff, -0.025, 0.036, 0.172, 0.018, 0.018, 0.009);
    pupils.push(pupil);
    const lid = sphere(eye, p.skin, 0, 0.13, 0.035, 0.24, 0.025, 0.15);
    if (x < 0) { leftEye = eye; leftLid = lid; } else { rightEye = eye; rightLid = lid; }
    const brow = sphere(head, p.hair, x, 0.43, 0.68, 0.25, 0.046, 0.07);
    brows.push(brow);
  }
  mouth = sphere(head, 0x794b46, 0, -0.55, 0.68, 0.22, 0.038, 0.04);
  sphere(head, 0xf0b5a0, -0.52, -0.38, 0.56, 0.15, 0.065, 0.035);
  sphere(head, 0xf0b5a0, 0.52, -0.38, 0.56, 0.15, 0.065, 0.035);
  if (props.member === "athena") {
    for (const x of [-0.34, 0.34]) {
      const glass = new THREE.Mesh(new THREE.TorusGeometry(0.245, 0.022, 8, 28), new THREE.MeshStandardMaterial({ color: 0x405b6a, metalness: 0.45, roughness: 0.3 }));
      glass.position.set(x, 0.16, 0.79);
      glass.scale.y = 0.75;
      head.add(glass);
    }
    sphere(head, 0x405b6a, 0, 0.19, 0.82, 0.12, 0.022, 0.025);
  }
  const resize = () => {
    if (!host.value || !renderer || !camera) return;
    const w = Math.max(32, host.value.clientWidth), h = Math.max(32, host.value.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  observer = new ResizeObserver(resize);
  observer.observe(host.value);
  const animate = () => {
    if (!renderer || !scene || !camera || !head) return;
    frame = requestAnimationFrame(animate);
    if (!visible) return;
    time += reducedMotion ? 0 : 0.016;
    const state = props.state;
    const thinking = state === "thinking";
    const reading = state === "reading";
    const typing = state === "typing";
    const speaking = state === "speaking";
    const targetX = thinking ? -0.13 : reading ? 0.1 : speaking ? 0.08 : 0;
    const targetY = thinking ? -0.1 : typing ? -0.15 : reading ? -0.08 : 0;
    head.rotation.y += (targetX + Math.sin(time * 0.62) * 0.035 - head.rotation.y) * 0.045;
    head.rotation.x += (targetY + Math.sin(time * 0.8) * 0.022 - head.rotation.x) * 0.045;
    head.position.y = Math.sin(time * 1.3) * 0.022;
    const blink = Math.pow(Math.max(0, Math.sin(time * 1.75 + 1.1)), 36);
    const eyeHeight = Math.max(0.04, 1 - blink * 0.95);
    if (leftEye) leftEye.scale.y = eyeHeight;
    if (rightEye) rightEye.scale.y = eyeHeight;
    const gazeX = thinking ? -0.042 : reading ? Math.sin(time * 1.8) * 0.045 : typing ? 0.02 : 0;
    const gazeY = thinking ? 0.035 : typing ? -0.038 : 0;
    for (const pupil of pupils) {
      pupil.position.x += (gazeX - pupil.position.x) * 0.09;
      pupil.position.y += (gazeY - pupil.position.y) * 0.09;
    }
    for (const brow of brows) brow.position.y = 0.43 + (thinking ? 0.045 : speaking ? Math.sin(time * 5) * 0.02 : 0);
    if (mouth) {
      const open = speaking ? 0.04 + Math.abs(Math.sin(time * 8.5)) * 0.13 : typing ? 0.035 : 0.025;
      mouth.scale.y += (open - mouth.scale.y) * 0.25;
    }
    renderer.render(scene, camera);
  };
  animate();
}
onMounted(() => {
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  build();
  document.addEventListener("visibilitychange", visibilityChange);
});
function visibilityChange() { visible = !document.hidden; }
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", visibilityChange);
  cancelAnimationFrame(frame);
  observer?.disconnect();
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = undefined;
  scene?.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
});
</script>

<template>
  <span ref="host" class="agent-avatar" :class="[size, state]" role="img" :aria-label="`3D avatar: ${member}, ${state}`">
    <span class="fallback" aria-hidden="true">{{ member.slice(0, 1).toUpperCase() }}</span>
  </span>
</template>

<style scoped>
.agent-avatar { display: inline-block; position: relative; flex: none; width: 68px; height: 68px; border-radius: 20px; overflow: hidden; background: #edf0ee; isolation: isolate; }
.agent-avatar.small { width: 34px; height: 34px; border-radius: 11px; }
.agent-avatar :deep(canvas) { position: absolute; inset: 0; display: block; width: 100%; height: 100%; z-index: 1; }
.fallback { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 700; color: #6d7770; }
.agent-avatar.thinking { box-shadow: 0 0 0 2px #c6d9e9; }
.agent-avatar.typing { box-shadow: 0 0 0 2px #b8d8c8; }
.agent-avatar.speaking { box-shadow: 0 0 0 2px #e8d2ac; }
</style>
