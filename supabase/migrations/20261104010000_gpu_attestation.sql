-- NVIDIA NRAS GPU attestation result per inference call (src/lib/server/nras.ts).
-- The stored platform token is NVIDIA's signed verdict, so anyone can re-verify it.
alter table inference_calls
  add column gpu_attestation text check (gpu_attestation in ('PASS','FAIL','ERROR')),
  add column gpu_attestation_detail jsonb;
