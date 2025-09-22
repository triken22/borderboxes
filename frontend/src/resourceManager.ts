import * as THREE from 'three';

export interface ResourceStats {
  geometries: number;
  materials: number;
  textures: number;
  renderTargets: number;
}

class ResourceManager {
  private geometries = new Set<THREE.BufferGeometry>();
  private materials = new Set<THREE.Material>();
  private textures = new Set<THREE.Texture>();
  private renderTargets = new Set<THREE.WebGLRenderTarget>();

  trackGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  trackMaterial<T extends THREE.Material>(material: T): T {
    this.materials.add(material);
    return material;
  }

  trackTexture<T extends THREE.Texture>(texture: T): T {
    this.textures.add(texture);
    return texture;
  }

  trackRenderTarget<T extends THREE.WebGLRenderTarget>(target: T): T {
    this.renderTargets.add(target);
    return target;
  }

  dispose(): void {
    for (const geometry of this.geometries) {
      geometry.dispose();
    }
    for (const material of this.materials) {
      if ('map' in material && material.map) {
        material.map.dispose();
      }
      material.dispose();
    }
    for (const texture of this.textures) {
      texture.dispose();
    }
    for (const target of this.renderTargets) {
      target.dispose();
    }

    this.clear();
  }

  emergencyCleanup(): void {
    console.warn('ResourceManager emergency cleanup triggered');
    this.dispose();
  }

  clear(): void {
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.renderTargets.clear();
  }

  getStats(): ResourceStats {
    return {
      geometries: this.geometries.size,
      materials: this.materials.size,
      textures: this.textures.size,
      renderTargets: this.renderTargets.size
    };
  }
}

export const resourceManager = new ResourceManager();
