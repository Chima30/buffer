-- Keep the exact message NEAR AI signed, so anyone can re-check the signature offline.
alter table inference_calls add column signature_text text;
