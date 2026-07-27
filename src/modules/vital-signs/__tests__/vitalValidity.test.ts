import { describe, it, expect } from 'vitest';
import {
  evaluateVigency,
  evaluateCoupledVigency,
  type TimedVital,
} from '../vitalValidity';

const T0 = 1_000_000;
const at = (value: number, ageMs = 0): TimedVital => ({
  value,
  measuredAtMs: T0 - ageMs,
});

describe('evaluateVigency', () => {
  describe('EL CASO QUE MOTIVÓ TODO: se retira el dedo', () => {
    it('un valor recién medido deja de publicarse si la evidencia dice que no hay sangre', () => {
      // Este es exactamente el bug: el valor era válido hace un instante, pero
      // el dedo ya no está. Su antigüedad es irrelevante.
      const v = evaluateVigency(at(72, 0), 'NOT_PERFUSED', T0);

      expect(v.publishable).toBe(false);
      expect(v.freshness).toBe('EXPIRED');
    });

    it('no importa cuán reciente sea: sin sangre no hay valor', () => {
      for (const age of [0, 100, 500, 1000]) {
        const v = evaluateVigency(at(98, age), 'NOT_PERFUSED', T0);
        expect(v.publishable).toBe(false);
      }
    });
  });

  describe('vigencia normal', () => {
    it('publica como FRESH con evidencia positiva y valor reciente', () => {
      const v = evaluateVigency(at(72, 200), 'PERFUSED', T0);

      expect(v.freshness).toBe('FRESH');
      expect(v.publishable).toBe(true);
      expect(v.ageMs).toBe(200);
    });

    it('sobrevive como STALE si la evidencia está indecisa pero el valor es reciente', () => {
      const v = evaluateVigency(at(72, 800), 'UNDECIDED', T0);

      expect(v.freshness).toBe('STALE');
      expect(v.publishable).toBe(true);
    });

    it('expira al superar la ventana aunque la evidencia sea positiva', () => {
      const v = evaluateVigency(at(72, 5000), 'PERFUSED', T0);

      expect(v.freshness).toBe('EXPIRED');
      expect(v.publishable).toBe(false);
    });

    it('el límite de la ventana es 2 s', () => {
      expect(evaluateVigency(at(72, 2000), 'UNDECIDED', T0).publishable).toBe(true);
      expect(evaluateVigency(at(72, 2001), 'UNDECIDED', T0).publishable).toBe(false);
    });
  });

  describe('ausencia de valor', () => {
    it('null no es publicable', () => {
      expect(evaluateVigency(null, 'PERFUSED', T0).publishable).toBe(false);
    });

    it('cero significa "no hay valor", no "cero fisiológico"', () => {
      expect(evaluateVigency(at(0, 0), 'PERFUSED', T0).publishable).toBe(false);
    });

    it('un sello de tiempo inválido no es publicable', () => {
      const v = evaluateVigency({ value: 72, measuredAtMs: 0 }, 'PERFUSED', T0);
      expect(v.publishable).toBe(false);
    });
  });
});

describe('evaluateCoupledVigency — los tres caducan juntos', () => {
  it('si la frecuencia expira, arrastra a oxígeno y presión aunque sean recientes', () => {
    // Sin latidos no hay componente pulsátil del que sacar AC/DC: la
    // saturación y la presión heredaron su validez de la frecuencia.
    const r = evaluateCoupledVigency(
      {
        heartRate: at(72, 9000), // vieja
        spo2: at(98, 0), // recién calculada
        bloodPressure: at(120, 0), // recién calculada
      },
      'PERFUSED',
      T0,
    );

    expect(r.heartRate.publishable).toBe(false);
    expect(r.spo2.publishable).toBe(false);
    expect(r.bloodPressure.publishable).toBe(false);
    expect(r.anyPublishable).toBe(false);
  });

  it('sin evidencia de perfusión no se publica ninguno de los tres', () => {
    const r = evaluateCoupledVigency(
      { heartRate: at(72, 0), spo2: at(98, 0), bloodPressure: at(120, 0) },
      'NOT_PERFUSED',
      T0,
    );

    expect(r.anyPublishable).toBe(false);
  });

  it('con evidencia y valores frescos publica los tres', () => {
    const r = evaluateCoupledVigency(
      { heartRate: at(72, 100), spo2: at(98, 150), bloodPressure: at(120, 200) },
      'PERFUSED',
      T0,
    );

    expect(r.heartRate.freshness).toBe('FRESH');
    expect(r.spo2.freshness).toBe('FRESH');
    expect(r.bloodPressure.freshness).toBe('FRESH');
    expect(r.anyPublishable).toBe(true);
  });

  it('la frecuencia puede publicarse sola si oxígeno y presión aún no existen', () => {
    // Caso legítimo al inicio: ya hay latidos pero todavía no ciclos
    // suficientes para morfología ni ratio estable.
    const r = evaluateCoupledVigency(
      { heartRate: at(72, 100), spo2: null, bloodPressure: null },
      'PERFUSED',
      T0,
    );

    expect(r.heartRate.publishable).toBe(true);
    expect(r.spo2.publishable).toBe(false);
    expect(r.anyPublishable).toBe(true);
  });

  it('no se publica un cuadro clínico mezclando instantes distintos', () => {
    // Oxígeno de hace 20 s conviviendo con presión de hace 30 s: era
    // exactamente lo que se veía en pantalla al sacar el dedo.
    const r = evaluateCoupledVigency(
      { heartRate: at(72, 100), spo2: at(98, 20000), bloodPressure: at(120, 30000) },
      'PERFUSED',
      T0,
    );

    expect(r.heartRate.publishable).toBe(true);
    expect(r.spo2.publishable).toBe(false);
    expect(r.bloodPressure.publishable).toBe(false);
  });
});
