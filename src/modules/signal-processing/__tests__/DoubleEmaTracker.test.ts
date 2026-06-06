import { describe, expect, it } from 'vitest';
import { DoubleEmaTracker } from '../PPGSignalSplitter';

describe('DoubleEmaTracker', () => {
  it('se inicializa con la primera muestra', () => {
    const tracker = new DoubleEmaTracker(0.015);
    const val = tracker.push(100.0);
    expect(val).toBe(100.0);
  });

  it('sigue una señal constante perfectamente', () => {
    const tracker = new DoubleEmaTracker(0.015);
    tracker.push(150.0);
    for (let i = 0; i < 50; i++) {
      const val = tracker.push(150.0);
      expect(val).toBeCloseTo(150.0, 5);
    }
  });

  it('compensa la deriva en una rampa lineal (zero phase-lag)', () => {
    const tracker = new DoubleEmaTracker(0.05);
    tracker.push(100);
    
    // Debería adaptarse a una rampa lineal: x(t) = 100 + 2*t
    let lastOutput = 0;
    for (let t = 1; t <= 300; t++) {
      const input = 100 + 2 * t;
      lastOutput = tracker.push(input);
    }

    // Un EMA simple tendría un retraso de (1-alpha)/alpha = 19 muestras, lo que da un error de 38 unidades.
    // DEMA debería tener un error residual muy pequeño debido a la compensación de deriva.
    const expectedFinal = 100 + 2 * 300; // 700
    const err = Math.abs(lastOutput - expectedFinal);
    expect(err).toBeLessThan(5.0); // Prácticamente coincide
  });

  it('acelera la convergencia ante saltos bruscos (>15%)', () => {
    const tracker = new DoubleEmaTracker(0.01);
    
    // Inicializar y estabilizar en 100
    tracker.push(100);
    for (let i = 0; i < 50; i++) tracker.push(100);

    // Salto brusco a 200 (100% de incremento)
    let val = 0;
    for (let i = 0; i < 5; i++) {
      val = tracker.push(200);
    }
    
    // Con alpha = 0.01, un EMA simple se movería a: ~105 en 5 muestras
    // Pero con la aceleración adaptativa por cambio brusco, la convergencia es mucho más rápida.
    expect(val).toBeGreaterThan(140); 
  });
});
