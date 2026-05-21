declare global {
  interface ScreenOrientation {
    angle: number;
    onchange: ((this: ScreenOrientation, ev: Event) => unknown) | null;
    type: OrientationType;
    lock(orientation: OrientationLockType): Promise<void>;
    unlock(): void;
  }

  type OrientationLockType =
    | 'any'
    | 'natural'
    | 'landscape'
    | 'portrait'
    | 'portrait-primary'
    | 'portrait-secondary'
    | 'landscape-primary'
    | 'landscape-secondary';

  type OrientationType = OrientationLockType;

  interface Screen {
    orientation?: ScreenOrientation;
  }

  // WakeLock API
  interface WakeLockSentinel {
    readonly released: boolean;
    readonly type: 'screen';
    release(): Promise<void>;
    onrelease: ((this: WakeLockSentinel, ev: Event) => unknown) | null;
  }

  interface WakeLock {
    request(type: 'screen'): Promise<WakeLockSentinel>;
  }

  interface Navigator {
    wakeLock?: WakeLock;
    readonly deviceMemory?: number;
  }
}

export {};
