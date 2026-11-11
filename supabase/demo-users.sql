-- Demo-only staff logins for the in-browser demo and tests (PGlite).
insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-000000000001', 'founder@demo.local'),
  ('00000000-0000-4000-a000-000000000002', 'packer@demo.local'),
  ('00000000-0000-4000-a000-000000000003', 'warehouse@demo.local');
insert into staff_profiles (user_id, full_name, role) values
  ('00000000-0000-4000-a000-000000000001', 'Founder (admin)', 'admin'),
  ('00000000-0000-4000-a000-000000000002', 'Ravi (packer)', 'packer'),
  ('00000000-0000-4000-a000-000000000003', 'Sunita (warehouse)', 'warehouse');

-- Sample company GST details for the demo and tests only (sample GSTIN format, not a real registration)
update legal_entities set state_code = '36', gstin = '36AAACT1234A1Z5', pan = 'AAACT1234A',
       registered_address = 'Sample address, Hyderabad, Telangana 500001';
