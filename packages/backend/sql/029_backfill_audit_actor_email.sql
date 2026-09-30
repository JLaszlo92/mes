-- 029: hiányzó actor_email kitöltése a meglévő audit bejegyzésekben.
--
-- A recordAuditEvent korábban csak akkor írta az actor_email-t, ha a hívó
-- átadta (login/logout igen, a legtöbb route csak actorId-t adott), így az
-- Audit log panelen ezeknél nem látszott, ki végezte a műveletet. Mivel az
-- actor_id FK-ja ON DELETE SET NULL, egy törölt felhasználó bejegyzései
-- e-mail nélkül végleg azonosíthatatlanná válnának. Az audit-repository.ts
-- mostantól íráskor maga tölti ki; ez a migráció a régi sorokat pótolja.
--
-- Megjegyzés: a pótolt érték a felhasználó MOSTANI e-mail címe (a korábbi
-- nem ismert). Idempotens: csak a még üres sorokat érinti.
UPDATE audit_log al
SET actor_email = u.email
FROM users u
WHERE al.actor_email IS NULL
  AND al.actor_id = u.id;