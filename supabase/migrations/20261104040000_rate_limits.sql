-- Per-IP (hashed) request counters for public endpoints.
create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);
alter table rate_limits enable row level security;
revoke all on rate_limits from anon, authenticated;

create function hit_rate_limit(p_key text, p_window timestamptz) returns int language sql as $$
  insert into rate_limits (key, window_start, hits) values (p_key, p_window, 1)
  on conflict (key, window_start) do update set hits = rate_limits.hits + 1
  returning hits;
$$;
revoke execute on function hit_rate_limit(text, timestamptz) from public, anon, authenticated;
