export function selectNativeTargetFps(best: number): number {
  return best >= 60 ? 60 : best >= 30 ? 30 : Math.max(best, 15);
}
