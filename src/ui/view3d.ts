// three.js 三维预览：与 GLB 使用同一套网格数据（buildTownMeshes）

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Model } from '../town/model';
import { buildTownMeshes, type Primitive } from '../export/build3d';

export class View3D {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private group = new THREE.Group();
  private raf = 0;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#101216');
    this.scene.fog = new THREE.Fog('#101216', 260, 620);

    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 4000);
    this.camera.position.set(120, 130, 150);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 0, 0);

    // 光
    const hemi = new THREE.HemisphereLight('#cfd8e6', '#2a2620', 1.05);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight('#fff3dd', 2.1);
    sun.position.set(90, 160, 70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 180;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 620;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight('#8fa4c4', 0.45);
    fill.position.set(-110, 70, -90);
    this.scene.add(fill);

    this.scene.add(this.group);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop();
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  setModel(
    model: Model,
    opts: {
      heightScale?: number;
      markings?: boolean;
      furniture?: boolean;
      layers?: (id: string) => boolean;
    } = {}
  ): void {
    this.clear();

    const prims = buildTownMeshes(model, {
      heightScale: opts.heightScale ?? 1,
      markings: opts.markings ?? true,
      furniture: opts.furniture ?? true,
      layers: opts.layers,
    });
    const matCache = new Map<string, THREE.MeshStandardMaterial>();

    for (const prim of prims) {
      if (!prim || prim.indices.length === 0) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(prim.positions, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(prim.normals, 3));
      geom.setIndex(prim.indices);

      const key = prim.color.join(',');
      let mat = matCache.get(key);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(prim.color[0], prim.color[1], prim.color[2]),
          roughness: 0.94,
          metalness: 0,
        });
        matCache.set(key, mat);
      }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = prim.group !== 'ground' && prim.group !== 'street' && prim.group !== 'plaza';
      mesh.receiveShadow = true;
      mesh.name = prim.name;
      mesh.userData.group = prim.group;
      this.group.add(mesh);
    }

    // 地面接收阴影的底盘
    const radius = model.cityRadius || 100;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 1.9, 64),
      new THREE.MeshStandardMaterial({ color: '#1c1f24', roughness: 1 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.35;
    disc.receiveShadow = true;
    this.group.add(disc);

    this.controls.target.set(0, 0, 0);
    const dist = radius * 2.6;
    this.camera.position.set(dist * 0.62, dist * 0.72, dist * 0.78);
    this.camera.near = 1;
    this.camera.far = radius * 40;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private clear(): void {
    for (const child of this.group.children.slice()) {
      this.group.remove(child);
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  }

  /** 导出用：返回与预览一致的网格数据 */
  static meshes(model: Model, opts: { heightScale?: number } = {}): Primitive[] {
    return buildTownMeshes(model, opts);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.clear();
    this.renderer.dispose();
  }
}
