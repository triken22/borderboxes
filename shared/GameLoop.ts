export type PhysicsStep = (deltaMs: number) => void;
export type RenderStep = (interpolation: number, deltaMs: number) => void;

export class GameLoop {
  private lastTime = 0;
  private accumulator = 0;
  private readonly timestep: number;
  private readonly maxFrameTime: number;

  constructor(
    private readonly physicsUpdate: PhysicsStep,
    private readonly renderUpdate: RenderStep,
    updatesPerSecond = 60,
    maxFrameTimeMs = 100
  ) {
    this.timestep = 1000 / updatesPerSecond;
    this.maxFrameTime = maxFrameTimeMs;
  }

  reset(timeMs: number) {
    this.lastTime = timeMs;
    this.accumulator = 0;
  }

  tick(currentTimeMs: number): void {
    if (this.lastTime === 0) {
      this.reset(currentTimeMs);
      return;
    }

    const deltaMs = Math.min(currentTimeMs - this.lastTime, this.maxFrameTime);
    this.lastTime = currentTimeMs;
    this.accumulator += deltaMs;

    while (this.accumulator >= this.timestep) {
      this.physicsUpdate(this.timestep);
      this.accumulator -= this.timestep;
    }

    const alpha = this.timestep ? this.accumulator / this.timestep : 0;
    this.renderUpdate(alpha, deltaMs);
  }
}
