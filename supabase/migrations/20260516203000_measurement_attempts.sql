-- Intentos de medición (auditoría): siempre insertables; la tabla `measurements` solo filas finales válidas desde el cliente.
CREATE TABLE IF NOT EXISTS public.measurement_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (
    outcome IN (
      'valid_saved',
      'rejected_low_quality',
      'rejected_incomplete',
      'rejected_status',
      'rejected_auth'
    )
  ),
  signal_quality integer NOT NULL DEFAULT 0,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_measurement_attempts_user_created
  ON public.measurement_attempts (user_id, created_at DESC);

ALTER TABLE public.measurement_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own measurement attempts"
  ON public.measurement_attempts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own measurement attempts"
  ON public.measurement_attempts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own measurement attempts"
  ON public.measurement_attempts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
