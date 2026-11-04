-- Self-funding treasury: the contract keeps part of the owner's share as a reserve leg.
alter type payout_leg add value if not exists 'reserve';
