declare module 'three/examples/jsm/postprocessing/EffectComposer' {
  import { WebGLRenderer, WebGLRenderTarget } from 'three';
  export class EffectComposer {
    constructor(renderer: WebGLRenderer, renderTarget?: WebGLRenderTarget);
    addPass(pass: any): void;
    render(delta?: number): void;
    setSize(width: number, height: number): void;
    dispose(): void;
  }
  export default EffectComposer;
}

declare module 'three/examples/jsm/postprocessing/RenderPass' {
  import { Camera, Scene } from 'three';
  export class RenderPass {
    constructor(scene: Scene, camera: Camera);
    enabled: boolean;
  }
  export default RenderPass;
}

declare module 'three/examples/jsm/postprocessing/OutlinePass' {
  import { Camera, Scene, Vector2, Object3D } from 'three';
  export class OutlinePass {
    constructor(resolution: Vector2, scene: Scene, camera: Camera);
    edgeStrength: number;
    edgeGlow: number;
    edgeThickness: number;
    pulsePeriod: number;
    selectedObjects: Object3D[];
    setSize(width: number, height: number): void;
  }
  export default OutlinePass;
}

declare module 'three/examples/jsm/postprocessing/ShaderPass' {
  export class ShaderPass {
    constructor(shader: any);
    material: {
      uniforms: Record<string, { value: any }>;
    };
  }
  export default ShaderPass;
}

declare module 'three/examples/jsm/shaders/FXAAShader' {
  export const FXAAShader: {
    uniforms: Record<string, { value: any }>;
    vertexShader: string;
    fragmentShader: string;
  };
  export default FXAAShader;
}
