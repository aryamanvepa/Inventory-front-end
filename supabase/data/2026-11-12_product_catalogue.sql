-- =====================================================================
-- Product catalogue from "Product List for Website.xlsx" (2026-11-12)
-- 60 SKUs: Nutri Sampoorn 17, Mia Torte 43 (incl. 8 cookies).
-- Generated from the spreadsheet by a script; safe to run more than once.
--
--  * MRP: as in the sheet; where the sheet has none (Mia Torte muesli and
--    snacks) MRP = Selling Price, as agreed.
--  * Website price (WEB) = Selling Price, the highest display price.
--    "Revised Strategic Pricing" is stored in its own price list,
--    WEB_STRATEGIC, for the website's pricing logic to use when needed.
--  * GST: indicative rates from the GST 2.0 schedule (22 Sep 2025), all 5%
--    for these foods; the HSN codes and rates MUST be confirmed by the CA.
--  * Shelf life, reorder levels and recipes are not in the sheet: fill them
--    in the app (Admin → Products, Production → Recipes) before go-live.
--  * The 3 pilot sample products are kept for testing only: renamed
--    "TEST · …" and taken off the website (their website price is ended).
-- =====================================================================
begin;

-- Categories
update categories set name = 'Atta & flours' where name = 'Atta' and not exists (select 1 from categories where name = 'Atta & flours');
insert into categories (name)
select v from (values ('Atta & flours'), ('Dosa & batter mixes'), ('Chutney powders'), ('Muesli'), ('Snacks'), ('Cookies')) x(v)
 where not exists (select 1 from categories c where c.name = x.v);

-- GST (indicative, GST 2.0 from 22 Sep 2025 — CA to confirm)
update tax_rates set effective_to = date '2025-09-21'
 where hsn_code in ('1905', '2106') and gst_rate = 18 and effective_to is null and effective_from < date '2025-09-22';
insert into tax_rates (hsn_code, description, gst_rate, effective_from)
select h, d, 5, date '2025-09-22' from (values
  ('1905', 'Biscuits, cookies and bakery wares (indicative — CA to confirm)'),
  ('2106', 'Instant mixes, chutney powders, namkeen and snack mixes (indicative — CA to confirm)'),
  ('1904', 'Muesli and prepared cereal foods (indicative — CA to confirm)'),
  ('1106', 'Sattu / flour of pulses, pre-packaged (indicative — CA to confirm)')) x(h, d)
 where not exists (select 1 from tax_rates t where t.hsn_code = x.h and t.gst_rate = 5 and t.effective_to is null);
-- products still pointing at an ended rate move to the current rate for the same HSN
update products p set tax_rate_id = n.id
  from tax_rates o, tax_rates n
 where p.tax_rate_id = o.id and o.effective_to is not null and n.hsn_code = o.hsn_code and n.effective_to is null;

-- Strategic price list (used by the website's pricing logic when it needs to)
insert into price_lists (code, name, price_type, channel_id)
select 'WEB_STRATEGIC', 'Website strategic price (floor for dynamic pricing)', 'promotional', (select id from sales_channels where code = 'WEB')
 where not exists (select 1 from price_lists where code = 'WEB_STRATEGIC');

-- The catalogue
create temp table catalogue_import (ord int, brand text, category text, hsn text, product text, sku text,
  pack_size numeric, pack_unit text, mrp numeric, web numeric, strategic numeric) on commit drop;
insert into catalogue_import values
  (1, 'NS', 'Dosa & batter mixes', '2106', 'Instant MultiMillet Dosa Mix', 'Instant MultiMillet Dosa Mix 250 g', 250, 'g', 140, 120, null),
  (2, 'NS', 'Dosa & batter mixes', '2106', 'Instant Pesarattu Dosa Mix', 'Instant Pesarattu Dosa Mix 250 g', 250, 'g', 160, 140, null),
  (3, 'NS', 'Dosa & batter mixes', '2106', 'Instant Multigrain Dosa Mix', 'Instant Multigrain Dosa Mix 250 g', 250, 'g', 150, 130, null),
  (4, 'NS', 'Chutney powders', '2106', 'Instant Peanut Putana Chutney', 'Instant Peanut Putana Chutney 100 g', 100, 'g', 120, 100, null),
  (5, 'NS', 'Chutney powders', '2106', 'Instant Peanut Putana Chutney', 'Instant Peanut Putana Chutney 250 g', 250, 'g', 280, 230, null),
  (6, 'NS', 'Atta & flours', '1102', 'Multigrain Superseed Atta (MGA)', 'Multigrain Superseed Atta (MGA) 500 g', 500, 'g', 180, 160, null),
  (7, 'NS', 'Atta & flours', '1102', 'Multigrain Superseed Atta (MGA)', 'Multigrain Superseed Atta (MGA) 1 kg', 1, 'kg', 350, 300, null),
  (8, 'NS', 'Atta & flours', '1102', 'Gluten Free Superseed Atta', 'Gluten Free Superseed Atta 500 g', 500, 'g', 250, 220, null),
  (9, 'NS', 'Atta & flours', '1102', 'Gluten Free Superseed Atta', 'Gluten Free Superseed Atta 1 kg', 1, 'kg', 450, 400, null),
  (10, 'NS', 'Atta & flours', '1102', 'Ragi Flour', 'Ragi Flour 500 g', 500, 'g', 120, 100, null),
  (11, 'NS', 'Atta & flours', '1102', 'Ragi Flour', 'Ragi Flour 1 kg', 1, 'kg', 200, 180, null),
  (12, 'NS', 'Atta & flours', '1102', 'Bajra Flour', 'Bajra Flour 500 g', 500, 'g', 115, 95, null),
  (13, 'NS', 'Atta & flours', '1102', 'Bajra Flour', 'Bajra Flour 1 kg', 1, 'kg', 180, 160, null),
  (14, 'NS', 'Atta & flours', '1102', 'Jowar Flour', 'Jowar Flour 500 g', 500, 'g', 130, 110, null),
  (15, 'NS', 'Atta & flours', '1102', 'Jowar Flour', 'Jowar Flour 1 kg', 1, 'kg', 210, 190, null),
  (16, 'NS', 'Atta & flours', '1106', 'Sattu (Roasted Gram Flour)', 'Sattu (Roasted Gram Flour) 500 g', 500, 'g', 165, 145, null),
  (17, 'NS', 'Atta & flours', '1106', 'Sattu (Roasted Gram Flour)', 'Sattu (Roasted Gram Flour) 1 kg', 1, 'kg', 300, 275, null),
  (18, 'MT', 'Muesli', '1904', 'Fruit & Nut Muesli', 'Fruit & Nut Muesli 140 g Pet Jar', 140, 'g', 178, 178, 178),
  (19, 'MT', 'Muesli', '1904', 'Fruit & Nut Muesli', 'Fruit & Nut Muesli 150 g Pouch', 150, 'g', 180, 180, 180),
  (20, 'MT', 'Muesli', '1904', 'Fruit & Nut Muesli', 'Fruit & Nut Muesli 250 g Pouch', 250, 'g', 290, 290, 285),
  (21, 'MT', 'Muesli', '1904', 'Fruit & Nut Muesli', 'Fruit & Nut Muesli 500 g Pouch', 500, 'g', 565, 565, 550),
  (22, 'MT', 'Muesli', '1904', 'Nutty Mango Millets & Nuts Muesli', 'Nutty Mango Millets & Nuts Muesli 120 g Pet Jar', 120, 'g', 168, 168, 168),
  (23, 'MT', 'Muesli', '1904', 'Nutty Mango Millets & Nuts Muesli', 'Nutty Mango Millets & Nuts Muesli 150 g Pouch', 150, 'g', 195, 195, 195),
  (24, 'MT', 'Muesli', '1904', 'Nutty Mango Millets & Nuts Muesli', 'Nutty Mango Millets & Nuts Muesli 250 g Pouch', 250, 'g', 315, 315, 310),
  (25, 'MT', 'Muesli', '1904', 'Nutty Mango Millets & Nuts Muesli', 'Nutty Mango Millets & Nuts Muesli 500 g Pouch', 500, 'g', 615, 615, 585),
  (26, 'MT', 'Muesli', '1904', 'Nutty Orange Millets & Nuts Muesli', 'Nutty Orange Millets & Nuts Muesli 120 g Pet Jar', 120, 'g', 168, 168, 168),
  (27, 'MT', 'Muesli', '1904', 'Nutty Orange Millets & Nuts Muesli', 'Nutty Orange Millets & Nuts Muesli 150 g Pouch', 150, 'g', 195, 195, 195),
  (28, 'MT', 'Muesli', '1904', 'Nutty Orange Millets & Nuts Muesli', 'Nutty Orange Millets & Nuts Muesli 250 g Pouch', 250, 'g', 315, 315, 310),
  (29, 'MT', 'Muesli', '1904', 'Nutty Orange Millets & Nuts Muesli', 'Nutty Orange Millets & Nuts Muesli 500 g Pouch', 500, 'g', 615, 615, 585),
  (30, 'MT', 'Muesli', '1904', 'Crunchy Strawberry Millets & Nuts Muesli', 'Crunchy Strawberry Millets & Nuts Muesli 120 g Pet Jar', 120, 'g', 168, 168, 168),
  (31, 'MT', 'Muesli', '1904', 'Crunchy Strawberry Millets & Nuts Muesli', 'Crunchy Strawberry Millets & Nuts Muesli 150 g Pouch', 150, 'g', 195, 195, 195),
  (32, 'MT', 'Muesli', '1904', 'Crunchy Strawberry Millets & Nuts Muesli', 'Crunchy Strawberry Millets & Nuts Muesli 250 g Pouch', 250, 'g', 315, 315, 310),
  (33, 'MT', 'Muesli', '1904', 'Crunchy Strawberry Millets & Nuts Muesli', 'Crunchy Strawberry Millets & Nuts Muesli 500 g Pouch', 500, 'g', 615, 615, 585),
  (34, 'MT', 'Snacks', '2106', 'Peri Peri Vegie Chips', 'Peri Peri Vegie Chips 90 g Pouch', 90, 'g', 165, 165, 165),
  (35, 'MT', 'Snacks', '2106', 'Peri Peri Vegie Chips', 'Peri Peri Vegie Chips 250 g Pouch', 250, 'g', 440, 440, 425),
  (36, 'MT', 'Snacks', '2106', 'Peri Peri Vegie Chips', 'Peri Peri Vegie Chips 500 g Pouch', 500, 'g', 865, 865, 825),
  (37, 'MT', 'Snacks', '2106', 'Pudina Millet Crunch', 'Pudina Millet Crunch 100 g Pet Jar', 100, 'g', 125, 125, 125),
  (38, 'MT', 'Snacks', '2106', 'Pudina Millet Crunch', 'Pudina Millet Crunch 150 g Pouch', 150, 'g', 165, 165, 165),
  (39, 'MT', 'Snacks', '2106', 'Pudina Millet Crunch', 'Pudina Millet Crunch 250 g Pouch', 250, 'g', 265, 265, 260),
  (40, 'MT', 'Snacks', '2106', 'Pudina Millet Crunch', 'Pudina Millet Crunch 500 g Pouch', 500, 'g', 515, 515, 500),
  (41, 'MT', 'Snacks', '2106', 'Salted Nuts & Bean Crunch', 'Salted Nuts & Bean Crunch 170 g Pet Jar', 170, 'g', 230, 230, 230),
  (42, 'MT', 'Snacks', '2106', 'Salted Nuts & Bean Crunch', 'Salted Nuts & Bean Crunch 150 g Pouch', 150, 'g', 195, 195, 195),
  (43, 'MT', 'Snacks', '2106', 'Salted Nuts & Bean Crunch', 'Salted Nuts & Bean Crunch 250 g Pouch', 250, 'g', 315, 315, 310),
  (44, 'MT', 'Snacks', '2106', 'Salted Nuts & Bean Crunch', 'Salted Nuts & Bean Crunch 500 g Pouch', 500, 'g', 615, 615, 585),
  (45, 'MT', 'Snacks', '2106', 'Peri Peri Trail Mix', 'Peri Peri Trail Mix 175 g Pet Jar', 175, 'g', 235, 235, 235),
  (46, 'MT', 'Snacks', '2106', 'Peri Peri Trail Mix', 'Peri Peri Trail Mix 150 g Pouch', 150, 'g', 195, 195, 195),
  (47, 'MT', 'Snacks', '2106', 'Peri Peri Trail Mix', 'Peri Peri Trail Mix 250 g Pouch', 250, 'g', 315, 315, 310),
  (48, 'MT', 'Snacks', '2106', 'Peri Peri Trail Mix', 'Peri Peri Trail Mix 500 g Pouch', 500, 'g', 615, 615, 585),
  (49, 'MT', 'Snacks', '2106', 'Masala Protein Bean Mix', 'Masala Protein Bean Mix 120 g Pet Jar', 120, 'g', 165, 165, 165),
  (50, 'MT', 'Snacks', '2106', 'Masala Protein Bean Mix', 'Masala Protein Bean Mix 150 g Pouch', 150, 'g', 195, 195, 195),
  (51, 'MT', 'Snacks', '2106', 'Masala Protein Bean Mix', 'Masala Protein Bean Mix 250 g Pouch', 250, 'g', 315, 315, 310),
  (52, 'MT', 'Snacks', '2106', 'Masala Protein Bean Mix', 'Masala Protein Bean Mix 500 g Pouch', 500, 'g', 615, 615, 585),
  (53, 'MT', 'Cookies', '1905', 'Jowar Jeera Delight (8 nos.)', 'Jowar Jeera Delight (8 nos.) 160 g', 160, 'g', 160, 160, null),
  (54, 'MT', 'Cookies', '1905', 'Mocha Me Happy', 'Mocha Me Happy 60 g', 60, 'g', 160, 160, null),
  (55, 'MT', 'Cookies', '1905', 'Classic Chocolate Chip', 'Classic Chocolate Chip 60 g', 60, 'g', 160, 160, null),
  (56, 'MT', 'Cookies', '1905', 'Red Velvet Melt', 'Red Velvet Melt 60 g', 60, 'g', 160, 160, null),
  (57, 'MT', 'Cookies', '1905', 'Nutella Brownie Bliss', 'Nutella Brownie Bliss 70 g', 70, 'g', 180, 180, null),
  (58, 'MT', 'Cookies', '1905', 'Carrot Crème Melt', 'Carrot Crème Melt 70 g', 70, 'g', 200, 180, null),
  (59, 'MT', 'Cookies', '1905', 'Biscoff Indulgence', 'Biscoff Indulgence 70 g', 70, 'g', 200, 190, null),
  (60, 'MT', 'Cookies', '1905', 'Berry Nutty About Pista', 'Berry Nutty About Pista 70 g', 70, 'g', 200, 190, null);

insert into products (brand_id, category_id, name, tax_rate_id, is_batch_tracked)
select distinct on (b.id, ci.product) b.id, c.id, ci.product, t.id, true
  from catalogue_import ci join brands b on b.code = ci.brand join categories c on c.name = ci.category
  join tax_rates t on t.hsn_code = ci.hsn and t.effective_to is null
 where not exists (select 1 from products p where p.brand_id = b.id and p.name = ci.product)
 order by b.id, ci.product, ci.ord;

insert into skus (product_id, name, pack_size, pack_unit, mrp, reorder_level, weight_grams)
select p.id, ci.sku, ci.pack_size, ci.pack_unit, ci.mrp, 0, ci.pack_size * case ci.pack_unit when 'kg' then 1000 else 1 end
  from catalogue_import ci join brands b on b.code = ci.brand join products p on p.brand_id = b.id and p.name = ci.product
 where not exists (select 1 from skus s where s.product_id = p.id and s.name = ci.sku)
 order by ci.ord;

insert into price_list_items (price_list_id, sku_id, price)
select pl.id, s.id, v.price
  from catalogue_import ci join brands b on b.code = ci.brand join products p on p.brand_id = b.id and p.name = ci.product
  join skus s on s.product_id = p.id and s.name = ci.sku
  cross join lateral (values ('MRP', ci.mrp), ('WEB', ci.web), ('WEB_STRATEGIC', ci.strategic)) v(list, price)
  join price_lists pl on pl.code = v.list
 where v.price is not null
   and not exists (select 1 from price_list_items i where i.price_list_id = pl.id and i.sku_id = s.id);

-- Pilot samples: keep for testing, mark them, take them off the website
update products set name = 'TEST · ' || name
 where name not like 'TEST%' and id in (select product_id from skus
   where name in ('Chocolate Chip Cookies 200 g', 'Multigrain Atta 1 kg', 'Multigrain Atta 5 kg'));
update skus set name = 'TEST · ' || name
 where name in ('Chocolate Chip Cookies 200 g', 'Multigrain Atta 1 kg', 'Multigrain Atta 5 kg');
update price_list_items i set effective_to = today_ist() - 1
  from price_lists pl, skus s
 where pl.id = i.price_list_id and pl.code = 'WEB' and s.id = i.sku_id and s.name like 'TEST · %'
   and i.effective_to is null and i.effective_from <= today_ist() - 1;

commit;
