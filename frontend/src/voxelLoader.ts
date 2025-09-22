import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ColladaLoader, Collada } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';

function materialHasTexture(material: THREE.Material): material is THREE.Material & { map: THREE.Texture | null } {
  return typeof (material as { map?: unknown }).map !== 'undefined';
}

function materialSupportsFlatShading(material: THREE.Material): material is THREE.Material & { flatShading: boolean } {
  return typeof (material as { flatShading?: unknown }).flatShading === 'boolean';
}

export class VoxelModelLoader {
  private static instance: VoxelModelLoader;
  private modelCache: Map<string, THREE.Group> = new Map();
  private objLoader: OBJLoader;
  private colladaLoader: ColladaLoader;
  private mtlLoader: MTLLoader;
  private loadingPromises: Map<string, Promise<THREE.Group>> = new Map();

  private constructor() {
    this.objLoader = new OBJLoader();
    this.colladaLoader = new ColladaLoader();
    this.mtlLoader = new MTLLoader();
  }

  static getInstance(): VoxelModelLoader {
    if (!VoxelModelLoader.instance) {
      VoxelModelLoader.instance = new VoxelModelLoader();
    }
    return VoxelModelLoader.instance;
  }

  async loadModel(path: string, type: 'obj' | 'dae' | 'vox' = 'obj', scale = 1): Promise<THREE.Group> {
    // Check cache first
    const cacheKey = `${path}_${scale}`;
    if (this.modelCache.has(cacheKey)) {
      return this.modelCache.get(cacheKey)!.clone();
    }

    // Check if already loading
    if (this.loadingPromises.has(cacheKey)) {
      return this.loadingPromises.get(cacheKey)!.then(model => model.clone());
    }

    // Start loading
    const loadPromise = this.loadModelInternal(path, type, scale);
    this.loadingPromises.set(cacheKey, loadPromise);

    try {
      const model = await loadPromise;
      this.modelCache.set(cacheKey, model);
      this.loadingPromises.delete(cacheKey);
      return model.clone();
    } catch (error) {
      this.loadingPromises.delete(cacheKey);
      throw error;
    }
  }

  private async loadModelInternal(path: string, type: string, scale: number): Promise<THREE.Group> {
    switch (type) {
      case 'obj':
        return this.loadOBJModel(path, scale);
      case 'dae':
        return this.loadColladaModel(path, scale);
      case 'vox':
        return this.loadVoxModel(path, scale);
      default:
        throw new Error(`Unsupported model type: ${type}`);
    }
  }

  private loadOBJModel(path: string, scale: number): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      // Check if there's an MTL file
      const mtlPath = path.replace('.obj', '.mtl');
      const texturePath = path.replace('.obj', '.png');

      // Try loading with MTL first
      fetch(mtlPath)
        .then(() => {
          this.mtlLoader.load(
            mtlPath,
            (materials: MTLLoader.MaterialCreator) => {
              materials.preload();
              this.objLoader.setMaterials(materials);
              this.loadOBJWithLoader(path, scale, resolve, reject);
            },
            undefined,
            () => {
              // MTL failed, load OBJ with texture
              this.loadOBJWithTexture(path, texturePath, scale, resolve, reject);
            }
          );
        })
        .catch(() => {
          // No MTL, try with texture
          this.loadOBJWithTexture(path, texturePath, scale, resolve, reject);
        });
    });
  }

  private loadOBJWithLoader(path: string, scale: number, resolve: (value: THREE.Group) => void, reject: (reason?: unknown) => void) {
    this.objLoader.load(
      path,
      (object: THREE.Group) => {
        const group = new THREE.Group();
        group.add(object);
        group.scale.setScalar(scale);
        this.applyVoxelShading(group);
        resolve(group);
      },
      undefined,
      reject
    );
  }

  private loadOBJWithTexture(path: string, texturePath: string, scale: number, resolve: (value: THREE.Group) => void, reject: (reason?: unknown) => void) {
    // Reset materials
    this.objLoader.setMaterials(new MTLLoader.MaterialCreator(''));

    // Try loading texture
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      texturePath,
      (texture) => {
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;

        this.objLoader.load(
          path,
          (object: THREE.Group) => {
            const group = new THREE.Group();
            object.traverse((child: THREE.Object3D) => {
              if (child instanceof THREE.Mesh) {
                child.material = new THREE.MeshPhongMaterial({
                  map: texture,
                  flatShading: true
                });
              }
            });
            group.add(object);
            group.scale.setScalar(scale);
            this.applyVoxelShading(group);
            resolve(group);
          },
          undefined,
          reject
        );
      },
      undefined,
      () => {
        // No texture, load with basic material
        this.loadOBJBasic(path, scale, resolve, reject);
      }
    );
  }

  private loadOBJBasic(path: string, scale: number, resolve: (value: THREE.Group) => void, reject: (reason?: unknown) => void) {
    this.objLoader.load(
      path,
      (object: THREE.Group) => {
        const group = new THREE.Group();
        group.add(object);
        group.scale.setScalar(scale);
        this.applyVoxelShading(group);
        resolve(group);
      },
      undefined,
      reject
    );
  }

  private loadColladaModel(path: string, scale: number): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      this.colladaLoader.load(
        path,
        (collada: Collada) => {
          const group = new THREE.Group();
          group.add(collada.scene);
          group.scale.setScalar(scale);

          // Fix Z-UP coordinate system (rotate to Y-UP)
          group.rotation.x = -Math.PI / 2;

          this.applyVoxelShading(group);
          resolve(group);
        },
        undefined,
        reject
      );
    });
  }

  private loadVoxModel(_path: string, scale: number): Promise<THREE.Group> {
    // For VOX files, we'll create procedural voxel geometry
    // Since there's no built-in VOX loader, we'll use OBJ as fallback
    return this.createProceduralVoxelModel(scale);
  }

  private createProceduralVoxelModel(scale: number): Promise<THREE.Group> {
    return new Promise((resolve) => {
      const group = new THREE.Group();
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshPhongMaterial({
        color: 0x888888,
        flatShading: true
      });

      // Create a simple voxel structure
      const voxelSize = 0.1 * scale;
      const gridSize = 10;

      for (let x = 0; x < gridSize; x++) {
        for (let y = 0; y < gridSize * 1.5; y++) {
          for (let z = 0; z < gridSize; z++) {
            // Create a rough humanoid shape
            const dx = Math.abs(x - gridSize / 2);
            const dz = Math.abs(z - gridSize / 2);

            if (
              (y < 4 && dx < 2 && dz < 2) || // legs
              (y >= 4 && y < 10 && dx < 3 && dz < 2) || // body
              (y >= 10 && y < 14 && dx < 2 && dz < 2) // head
            ) {
              const voxel = new THREE.Mesh(geometry, material);
              voxel.position.set(
                (x - gridSize / 2) * voxelSize,
                y * voxelSize,
                (z - gridSize / 2) * voxelSize
              );
              voxel.scale.setScalar(voxelSize);
              group.add(voxel);
            }
          }
        }
      }

      resolve(group);
    });
  }

  private applyVoxelShading(group: THREE.Group) {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mesh = child;

        // Validate geometry exists and has valid data
        if (mesh.geometry && mesh.geometry.attributes.position) {
          const positions = mesh.geometry.attributes.position.array;
          let isValid = true;

          // Check for NaN or invalid values
          for (let i = 0; i < positions.length; i++) {
            if (isNaN(positions[i]) || !isFinite(positions[i])) {
              console.warn('Invalid geometry detected, skipping mesh');
              isValid = false;
              break;
            }
          }

          if (isValid && mesh.material) {
            if (Array.isArray(mesh.material)) {
              mesh.material.forEach(mat => this.configureVoxelMaterial(mat));
            } else {
              this.configureVoxelMaterial(mesh.material);
            }

            // Ensure bounding sphere is computed properly
            mesh.geometry.computeBoundingSphere();
          }
        }
      }
    });
  }

  private configureVoxelMaterial(material: THREE.Material) {
    if (materialHasTexture(material) && material.map) {
      material.map.magFilter = THREE.NearestFilter;
      material.map.minFilter = THREE.NearestFilter;
    }

    if (materialSupportsFlatShading(material)) {
      material.flatShading = true;
    }

    material.needsUpdate = true;
  }

  clearCache() {
    this.modelCache.clear();
    this.loadingPromises.clear();
  }
}