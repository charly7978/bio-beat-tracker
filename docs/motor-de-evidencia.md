# Motor de Evidencia Hemodinámica — Propuesta de diseño

**Estado:** propuesta, pendiente de aprobación. No implementada.
**Alcance acordado:** el motor de evidencia, y que gobierne BPM y SpO₂.

---

## 1. El problema, dicho sin adornos

Hoy la app produce un pulso "parejito" y un 98 % de oxígeno apuntando a una
pared. Eso no es imprecisión: es que el pipeline **no tiene forma de saber si
hay sangre en el camino óptico**. Busca periodicidad, y encuentra periodicidad
en el ruido — porque el ruido de un sensor CMOS bajo luz constante también
tiene estructura.

El diagnóstico correcto no es "hay que subir el umbral". Es que **la pregunta
está mal formulada**. La app pregunta *¿esto parece un dedo?* (color, cobertura,
textura), y una pared rosa responde que sí. La pregunta correcta es:

> ¿Cuánta evidencia física hay de que **hemoglobina arterial** esté pulsando
> en el camino óptico?

Una pared no tiene hemoglobina. No puede fingir la firma. Ese es el eje.

---

## 2. Por qué no una red neuronal

Se intentó y falló, por razones estructurales, no por falta de esfuerzo:

- No hay dataset etiquetado (nadie grabó miles de horas con oxímetro de
  referencia sincronizado).
- Una red que corra a 30 fps en un teléfono de gama media es pequeña; una
  pequeña sin datos aprende el sesgo del que la entrenó.
- Es opaca: cuando dé 98 % contra una pared, no hay forma de saber por qué.

El `training/` que había en el repo prometía tres modelos ONNX que **no
existían como archivos**, exportaban a un directorio inexistente y no tenían
runtime instalado. Era un cartel, no un cerebro.

Lo que sigue no es una red. Es **inferencia estadística sobre física conocida**,
que es más potente aquí precisamente porque la física de la absorción de la
hemoglobina *ya se conoce* — no hay que aprenderla de datos.

---

## 3. El hallazgo central: la firma del pulso sanguíneo (Pbv)

De Haan y van Leest (2014) demostraron algo que resuelve exactamente nuestro
problema. Cuando la sangre pulsa, la variación de color **no ocurre en una
dirección cualquiera del espacio RGB**: ocurre a lo largo de un vector muy
específico, determinado por los espectros de absorción de la sangre arterial y
de la piel sin sangre.

Ese vector se llama **firma normalizada del pulso sanguíneo, `Pbv`**, y se
define como (ec. 7 del paper):

```
        [ σ(Rn), σ(Gn), σ(Bn) ]
Pbv = ─────────────────────────────
      √( σ(Rn)² + σ(Gn)² + σ(Bn)² )
```

donde `Rn, Gn, Bn` son los canales de color normalizados y centrados en su
media temporal, y `σ` es la desviación estándar sobre la ventana de análisis.

Es decir: **la dirección en el espacio RGB por la que se mueve la parte
pulsátil de la señal.**

Tres hechos del paper que hacen que esto sirva:

1. **Predicción y medición coinciden dentro de 4°.** El vector medido sobre
   piel real y el predicho desde los espectros de absorción difieren solo 4
   grados. Es una firma estrecha y estable.
2. **Es estable a través de todo el rango de pigmentación de piel.** Más
   melanina aumenta la absorción absoluta, pero la absorción *relativa* entre
   longitudes de onda se mantiene. Esto importa muchísimo para una app real:
   funciona igual en piel clara y oscura.
3. **No requiere asumir que el pulso es la única componente periódica** — que
   es justo el supuesto que rompe a los métodos por ICA/PCA — ni supuestos
   sobre las distorsiones, como sí necesita CHROM.

### Por qué una pared no puede pasar

Una pared iluminada por el flash también tiene variación temporal: ruido del
sensor, parpadeo del LED, micro-movimientos de la mano. Pero esa variación
mueve los tres canales **proporcionalmente a su nivel DC** — es variación de
intensidad, y su dirección en RGB normalizado es la dirección de intensidad,
no la de la hemoglobina.

El ángulo entre ambas es grande y medible. **Esa es la prueba que no se puede
falsear**, y es lo que hoy falta.

---

## 4. El motor: evidencia que se multiplica, no puntaje que promedia

Este es el cambio conceptual que pediste: no un `if`, sino criterio.

Para cada canal de evidencia `i` se calcula una **razón de verosimilitud
logarítmica** (log-likelihood ratio):

```
Λᵢ = log [ p(observación | hay sangre) / p(observación | no hay sangre) ]
```

Y la evidencia total es la **suma**:

```
Λ = Σ Λᵢ
```

Sumar en espacio logarítmico equivale a **multiplicar** verosimilitudes. La
consecuencia es exactamente la que hace falta: **una sola evidencia fuertemente
negativa vetea a todas las demás.** Si la firma espectral no coincide con la
hemoglobina, no importa qué tan hermosa y periódica se vea la onda — Λ se
desploma y no hay medición.

Un puntaje promediado no puede hacer eso: deja que una evidencia fuerte pero
equivocada compense a la que realmente importa. Ese es, literalmente, el bug
de hoy.

### La decisión en el tiempo: SPRT

La evidencia se acumula frame a frame con el test secuencial de razón de
probabilidad de Wald (1945), con **dos umbrales y tres salidas**:

```
Λ(t) = λ · Λ(t−1) + Σ Λᵢ(t)        (λ = olvido exponencial)

Λ(t) ≥ A   →  HAY_SANGRE      (publicar vitales)
Λ(t) ≤ B   →  NO_HAY_SANGRE   (mostrar --, decir por qué)
B < Λ < A  →  TODAVÍA_NO_SÉ   (seguir midiendo, no publicar)
```

Esa tercera salida es la que la app no tiene hoy, y es la que evita tanto el
número inventado como el falso negativo. Además, **el valor de Λ es la
confianza**: no hay que inventar un porcentaje aparte, la matemática ya lo da.

Y responde a tu objeción sobre el tiempo: cinco segundos de evidencia débil
pero consistente **superan** a medio segundo de evidencia fuerte. Un umbral
instantáneo no puede expresar eso; una acumulación sí.

---

## 5. Los canales de evidencia

Cada uno es una medición física independiente, con su propio LLR continuo.

### 5.1 Alineación de firma espectral — **canal de veto**

```
p̂        = [σ(Rn), σ(Gn), σ(Bn)] / ‖·‖        (dirección observada)
θ        = arccos( p̂ · Pbv_ref )              (ángulo con la firma esperada)
Λ_firma  = log[ vMF(θ; κ_sangre) / Uniforme(θ) ]
```

Modelado con una distribución tipo von Mises–Fisher sobre la esfera: piel real
se concentra a ~4° de la firma; el ruido se distribuye ancho. Este canal puede
producir Λ muy negativo por sí solo, y debe poder hacerlo.

### 5.2 Estructura armónica del pulso proyectado

Se extrae el pulso con el método PBV (ecs. 9–10 del paper):

```
W_PBV = k · Pbv · Q⁻¹        con  Q = Cn · Cnᵀ  (covarianza 3×3)
S     = W_PBV · Cn
```

y se mide la concentración espectral de `S` en la banda cardíaca [0.7, 3.5] Hz,
comparando la energía en `f₀`, `2f₀` y `3f₀` contra la energía total de banda.

Un pulso cardíaco real tiene **armónicos** — la onda no es sinusoidal, tiene
subida sistólica abrupta. El ruido de banda ancha no los tiene. Esta es
evidencia independiente de la firma de color.

### 5.3 Asimetría morfológica (skewness)

La literatura de SQI es consistente: **la asimetría es el mejor índice
individual** para separar PPG limpio de ruido (F1 ≈ 86 %, superando a
perfusión, curtosis, entropía y cruces por cero). Razón física: la subida
sistólica es más empinada que la caída diastólica. El ruido es simétrico.

### 5.4 Índice de perfusión en banda fisiológica

`PI = AC/DC`. Tejido real cae en un rango acotado. Una pared da AC≈0 frente al
DC del flash; el movimiento da valores muy por encima del rango fisiológico.
Nótese que el LLR es **no monótono**: demasiado alto es tan sospechoso como
demasiado bajo. Un umbral simple no puede expresar eso; una verosimilitud sí.

### 5.5 Plausibilidad del cociente de cocientes — **el enlace con SpO₂**

```
R = (AC_rojo / DC_rojo) / (AC_verde / DC_verde)
```

Para sangre real, `R` cae en un rango fisiológico acotado. Si `R` está fuera,
lo que está pulsando no es hemoglobina.

**Y acá está la respuesta a tu pregunta de dónde sale el 98:** hoy sale de un
cálculo que puede correr aunque no haya sangre. En este diseño, `SpO₂` se
deriva de `R` — **la misma cantidad que sirve de evidencia de que hay sangre**.
Si `R` no es fisiológico, no hay evidencia, y entonces **no hay SpO₂ ni hay
BPM**. Quedan atados a la misma medición y no pueden contradecirse.

---

## 6. Autocalibración por dispositivo (sin pedirle nada al usuario)

Un punto de honestidad importante: el `Pbv` del paper se midió en **PPG remoto
sobre cara con luz halógena**. Nosotros hacemos **PPG de contacto con flash LED
blanco**. La firma no es la misma, y copiar los números del paper sería
exactamente el tipo de constante mágica que venimos sacando del repo.

Solución: **aprender `Pbv_ref` del propio dispositivo**, sin datos etiquetados
y sin intervención del usuario.

Durante segmentos donde el resto de la evidencia es abrumadora — estructura
armónica fuerte, PI fisiológico, morfología correcta, `R` estable — se registra
la dirección observada `p̂` y se actualiza `Pbv_ref` con una media circular
robusta. El dispositivo aprende su propia firma a partir de las mediciones
reales del usuario.

Se guarda por dispositivo. Arranca desde una estimación teórica amplia (κ bajo,
poco confiada) y se va concentrando a medida que acumula evidencia real.

### Guarda de saturación (obligatoria)

Con flash de contacto, **el canal rojo suele saturar**. Si el rojo clipea,
`σ(Rn)` queda artificialmente comprimido y el ángulo θ sale mal — daría un
falso negativo, o peor, un falso positivo si clipean dos canales.

Por eso: si la fracción de píxeles saturados supera lo tolerable, el canal 5.1
**no aporta evidencia** (Λ = 0, no un valor inventado) y se marca el motivo.
Es preferible que la app diga "no puedo decidir, bajá el brillo" a que decida
con una entrada corrupta.

---

## 7. Lo que esto sí y no promete

**Sí:**
- Apuntar a una pared, a la mesa o al aire deja de producir número. La firma
  espectral no coincide y Λ se desploma.
- BPM y SpO₂ quedan gobernados por la misma evidencia física.
- La confianza es un número real que sale de la matemática, no una etiqueta.
- Funciona igual en piel clara y oscura (propiedad demostrada del `Pbv`).

**No:**
- No convierte la presión arterial en algo confiable sin calibración. Eso
  requiere una referencia externa, y ninguna matemática lo esquiva.
- El **valor absoluto** de SpO₂ con canales RGB de banda ancha necesita una
  curva de calibración empírica; sin ella lo honesto es reportar `R` y su
  tendencia, no un porcentaje absoluto con dos decimales de autoridad.
- No es diagnóstico. Es una medición óptica con incertidumbre declarada.

---

## 8. Cómo se verifica que funciona

Sin esto, lo anterior es literatura bonita:

1. **Test de la pared** — vídeo apuntando a superficies (pared, mesa, papel,
   piel de otra persona sin contacto). Criterio de éxito: Λ nunca cruza `A`.
   Este test hoy **falla**, y es el que define si el trabajo sirvió.
2. **Test del dedo real** — grabaciones con dedo apoyado. Λ cruza `A` en menos
   de ~5 s, y el BPM concuerda con referencia.
3. **Test de transición** — dedo → retirar → pared. La app debe volver a `--`
   en menos de ~2 s, sin quedarse congelada en el último valor.
4. **Test de saturación** — flash muy cerca, rojo clipeado. Debe reportar
   "no puedo decidir", nunca un número.
5. **Presupuesto de cómputo** — el motor completo debe correr en < 3 ms por
   frame en gama media. Q es 3×3: la inversión es trivial, no hay excusa.

---

## 9. Referencias

- de Haan, G., & van Leest, A. (2014). *Improved motion robustness of
  remote-PPG by using the blood volume pulse signature.* Physiological
  Measurement, 35(9), 1913–1926. DOI 10.1088/0967-3334/35/9/1913 —
  **fuente del método PBV, ecuaciones 7, 9 y 10 citadas arriba.**
- Wang, W., den Brinker, A. C., Stuijk, S., & de Haan, G. (2017). *Algorithmic
  Principles of Remote PPG.* IEEE Trans. Biomed. Eng. — modelo óptico de la
  reflexión de piel; método POS.
- Elgendi, M. et al. (2016). *Optimal Signal Quality Index for
  Photoplethysmogram Signals.* Bioengineering 3(4), 21 — comparación de ocho
  SQI; la asimetría resulta el mejor índice individual.
- Wald, A. (1945). *Sequential Tests of Statistical Hypotheses.* — SPRT, base
  de la acumulación de evidencia con tres salidas.
- van Gastel, M., Stuijk, S., & de Haan, G. (2016). *New principle for
  measuring arterial blood oxygenation, enabling motion-robust remote
  monitoring.* Scientific Reports 6, 38609 — dependencia de la firma con la
  saturación de oxígeno.
