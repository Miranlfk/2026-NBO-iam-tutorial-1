import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * DB_PATH lets the API and the MCP server open the same file from a shared
 * volume (containers). Unset, it keeps the local default next to the API.
 * Resolved lazily so a .env loaded after this module is imported still counts.
 */
export function getDatabasePath() {
  const configured = process.env.DB_PATH?.trim();

  return configured ? resolve(configured) : resolve(__dirname, "..", "wayfinder.sqlite");
}

let db;

/**
 * A booking named an item that is not in the catalogue. Agents invent
 * plausible-looking IDs, so this is a routine rejection rather than a fault:
 * callers map it to 400 so the model can retry with an ID from a search.
 */
export class UnknownBookingItemError extends Error {
  statusCode = 400;

  constructor(type, itemId) {
    super(`Unknown ${type} ID: ${itemId}. Use an ID returned by a search.`);
    this.name = "UnknownBookingItemError";
  }
}

/**
 * Tables `npm run seed` builds from schema.sql. `ensureSchema` cannot create
 * them itself -- it has no catalogue data to put in them, and an empty flights
 * table would leave every search silently returning nothing.
 */
const CATALOGUE_TABLES = ["flights", "hotels", "trips"];

/**
 * The bookings_reject_unknown_item_* triggers read the catalogue tables.
 * SQLite accepts a trigger that names a missing table and only fails when the
 * trigger fires, so an unseeded database would reach the first booking and
 * report `no such table: main.flights`. Check up front instead, so the error
 * names the fix at startup.
 */
function assertCatalogueTables(database) {
  const present = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  );
  const missing = CATALOGUE_TABLES.filter((table) => !present.has(table));

  if (missing.length > 0) {
    const label = missing.length === 1 ? "table" : "tables";

    throw new Error(
      `SQLite database is missing the ${missing.join(", ")} ${label}. ` +
      "Run `npm run seed` from the api directory."
    );
  }
}

function ensureSchema(database) {
  assertCatalogueTables(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      booking_reference TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      travelers INTEGER NOT NULL,
      booking_price REAL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      booked_by_agent_id TEXT,
      booked_by_agent_name TEXT
    );

    CREATE TABLE IF NOT EXISTS deal_alert_consents (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      username TEXT NOT NULL,
      route_from TEXT NOT NULL,
      route_to TEXT NOT NULL,
      criteria_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (booking_id, username),
      FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
    );

    -- bookings.item_id is polymorphic, so it cannot take a foreign key. These
    -- triggers are the equivalent guard: a booking may only point at a catalogue
    -- row that exists, whichever writer inserts it.
    CREATE TRIGGER IF NOT EXISTS bookings_reject_unknown_item_insert
    BEFORE INSERT ON bookings
    FOR EACH ROW
    WHEN NOT EXISTS (
      SELECT 1 FROM flights WHERE NEW.type = 'flight' AND flights.id = NEW.item_id
      UNION ALL
      SELECT 1 FROM hotels WHERE NEW.type = 'hotel' AND hotels.id = NEW.item_id
      UNION ALL
      SELECT 1 FROM trips WHERE NEW.type = 'trip' AND trips.id = NEW.item_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'bookings.item_id does not match a known flight, hotel or trip');
    END;

    CREATE TRIGGER IF NOT EXISTS bookings_reject_unknown_item_update
    BEFORE UPDATE OF type, item_id ON bookings
    FOR EACH ROW
    WHEN NOT EXISTS (
      SELECT 1 FROM flights WHERE NEW.type = 'flight' AND flights.id = NEW.item_id
      UNION ALL
      SELECT 1 FROM hotels WHERE NEW.type = 'hotel' AND hotels.id = NEW.item_id
      UNION ALL
      SELECT 1 FROM trips WHERE NEW.type = 'trip' AND trips.id = NEW.item_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'bookings.item_id does not match a known flight, hotel or trip');
    END;

    CREATE TRIGGER IF NOT EXISTS delete_deal_alert_consents_after_booking_delete
    AFTER DELETE ON bookings
    FOR EACH ROW
    BEGIN
      DELETE FROM deal_alert_consents
      WHERE booking_id = OLD.id;
    END;
  `);

  const bookingColumns = database.prepare("PRAGMA table_info(bookings)").all() as { name: string }[];
  const hasBookingReference = bookingColumns.some((column) => column.name === "booking_reference");
  const hasBookingPrice = bookingColumns.some((column) => column.name === "booking_price");
  const hasBookedByAgentId = bookingColumns.some((column) => column.name === "booked_by_agent_id");
  const hasBookedByAgentName = bookingColumns.some((column) => column.name === "booked_by_agent_name");

  if (!hasBookingReference) {
    database.exec("ALTER TABLE bookings ADD COLUMN booking_reference TEXT;");
  }

  if (!hasBookingPrice) {
    database.exec("ALTER TABLE bookings ADD COLUMN booking_price REAL;");
  }

  if (!hasBookedByAgentId) {
    database.exec("ALTER TABLE bookings ADD COLUMN booked_by_agent_id TEXT;");
  }

  if (!hasBookedByAgentName) {
    database.exec("ALTER TABLE bookings ADD COLUMN booked_by_agent_name TEXT;");
  }

  const dealAlertColumns = database.prepare("PRAGMA table_info(deal_alert_consents)").all();
  const hasCriteriaJson = dealAlertColumns.some((column) => column.name === "criteria_json");

  if (!hasCriteriaJson) {
    database.exec("ALTER TABLE deal_alert_consents ADD COLUMN criteria_json TEXT NOT NULL DEFAULT '{}';");
  }

  ensureDealAlertConsentCascade(database);

  const bookingsWithoutReference = database
    .prepare("SELECT id FROM bookings WHERE booking_reference IS NULL OR booking_reference = ''")
    .all();

  const updateBookingReference = database.prepare(
    "UPDATE bookings SET booking_reference = @bookingReference WHERE id = @id"
  );

  for (const booking of bookingsWithoutReference) {
    const source = String(booking.id || "").replace(/^booking-/i, "").replace(/[^a-z0-9]/gi, "");
    const bookingReference = source.toUpperCase().padEnd(6, "0").slice(0, 6);

    updateBookingReference.run({
      id: booking.id,
      bookingReference
    });
  }

  database.exec(`
    UPDATE bookings
    SET booking_price = (
      SELECT flights.price
      FROM flights
      WHERE flights.id = bookings.item_id
    )
    WHERE type = 'flight'
      AND booking_price IS NULL;
  `);
}

function ensureDealAlertConsentCascade(database) {
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(deal_alert_consents)").all();
  const hasBookingCascade = foreignKeys.some((foreignKey) => (
    foreignKey.table === "bookings" &&
    foreignKey.from === "booking_id" &&
    String(foreignKey.on_delete).toUpperCase() === "CASCADE"
  ));

  if (hasBookingCascade) {
    return;
  }

  database.pragma("foreign_keys = OFF");

  const migrateDealAlerts = database.transaction(() => {
    database.exec(`
      CREATE TABLE deal_alert_consents_new (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL,
        username TEXT NOT NULL,
        route_from TEXT NOT NULL,
        route_to TEXT NOT NULL,
        criteria_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (booking_id, username),
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
      );

      INSERT INTO deal_alert_consents_new (
        id,
        booking_id,
        username,
        route_from,
        route_to,
        criteria_json,
        enabled,
        created_at,
        updated_at
      )
      SELECT
        id,
        booking_id,
        username,
        route_from,
        route_to,
        criteria_json,
        enabled,
        created_at,
        updated_at
      FROM deal_alert_consents
      WHERE EXISTS (
        SELECT 1
        FROM bookings
        WHERE bookings.id = deal_alert_consents.booking_id
      );

      DROP TABLE deal_alert_consents;
      ALTER TABLE deal_alert_consents_new RENAME TO deal_alert_consents;
    `);
  });

  try {
    migrateDealAlerts();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

function getDatabase() {
  const dbPath = getDatabasePath();

  if (!existsSync(dbPath)) {
    throw new Error(`SQLite database not found at ${dbPath}. Run \`npm run seed\` from the api directory.`);
  }

  if (!db) {
    db = new Database(dbPath);
    // Two processes (the API and the MCP server) open this file. WAL lets
    // readers proceed while one writes; the seed script sets it too, and it
    // persists in the file, so this is a no-op on a seeded database.
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    db.pragma("foreign_keys = ON");
  }

  return db;
}

/** Open the database (and apply schema upgrades) before serving traffic. */
export function initializeDatabase() {
  getDatabase();
}

function parseJsonArray(value) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");

    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapFlight(row) {
  return {
    id: row.id,
    from: row.from_city,
    to: row.to_city,
    airline: row.airline,
    departureTime: row.departure_time,
    arrivalTime: row.arrival_time,
    duration: row.duration,
    stops: row.stops,
    price: row.price,
    currency: row.currency,
    cabin: row.cabin,
    dates: row.dates,
    tags: parseJsonArray(row.tags)
  };
}

function mapHotel(row) {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    nightlyRate: row.nightly_rate,
    currency: row.currency,
    rating: row.rating,
    amenities: parseJsonArray(row.amenities)
  };
}

function mapTrip(row) {
  return {
    id: row.id,
    title: row.title,
    destination: row.destination,
    flightId: row.flight_id,
    hotelId: row.hotel_id,
    status: row.status,
    totalEstimate: row.total_estimate,
    currency: row.currency
  };
}

export function findFlights({ from, to, cabin }) {
  const conditions = [];
  const params = {};

  if (from) {
    conditions.push("LOWER(from_city) LIKE LOWER(@from)");
    params.from = `%${from}%`;
  }

  if (to) {
    conditions.push("LOWER(to_city) LIKE LOWER(@to)");
    params.to = `%${to}%`;
  }

  if (cabin) {
    conditions.push("LOWER(cabin) LIKE LOWER(@cabin)");
    params.cabin = `%${cabin}%`;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDatabase()
    .prepare(`SELECT * FROM flights ${whereClause} ORDER BY price ASC`)
    .all(params);

  return rows.map(mapFlight);
}

export function findFlightById(id) {
  const row = getDatabase()
    .prepare("SELECT * FROM flights WHERE id = @id")
    .get({ id });

  return row ? mapFlight(row) : null;
}

export function findHotelById(id) {
  const row = getDatabase()
    .prepare("SELECT * FROM hotels WHERE id = @id")
    .get({ id });

  return row ? mapHotel(row) : null;
}

function findTripById(id) {
  return getDatabase()
    .prepare("SELECT * FROM trips WHERE id = @id")
    .get({ id }) || null;
}

/**
 * Resolve the catalogue row a booking points at, or reject the booking.
 * `bookings.item_id` is polymorphic, so the lookup is per type; the
 * `bookings_reject_unknown_item_*` triggers enforce the same rule in SQL for
 * any writer that does not come through here.
 */
function findBookingItem(type, itemId) {
  const item =
    type === "flight" ? findFlightById(itemId) :
    type === "hotel" ? findHotelById(itemId) :
    type === "trip" ? findTripById(itemId) :
    null;

  if (!item) {
    throw new UnknownBookingItemError(type, itemId);
  }

  return item;
}

export function createFlightRecord({
  id,
  from,
  to,
  airline,
  departureTime,
  arrivalTime,
  duration,
  stops,
  price,
  currency,
  cabin,
  dates,
  tags
}) {
  getDatabase()
    .prepare(
      `
        INSERT INTO flights (
          id,
          from_city,
          to_city,
          airline,
          departure_time,
          arrival_time,
          duration,
          stops,
          price,
          currency,
          cabin,
          dates,
          tags
        ) VALUES (
          @id,
          @from,
          @to,
          @airline,
          @departureTime,
          @arrivalTime,
          @duration,
          @stops,
          @price,
          @currency,
          @cabin,
          @dates,
          @tags
        )
      `
    )
    .run({
      id,
      from,
      to,
      airline,
      departureTime,
      arrivalTime,
      duration,
      stops,
      price,
      currency,
      cabin,
      dates,
      tags: JSON.stringify(Array.isArray(tags) ? tags : [])
    });

  return findFlightById(id);
}

export function deleteFlightById(id) {
  const database = getDatabase();
  const flight = findFlightById(id);

  if (!flight) {
    return { deleted: false, reason: "not-found" };
  }

  const bookingCount = database
    .prepare("SELECT COUNT(*) AS count FROM bookings WHERE type = 'flight' AND item_id = @id")
    .get({ id }).count;
  const tripCount = database
    .prepare("SELECT COUNT(*) AS count FROM trips WHERE flight_id = @id")
    .get({ id }).count;

  if (bookingCount > 0 || tripCount > 0) {
    return {
      deleted: false,
      reason: "in-use",
      bookingCount,
      tripCount
    };
  }

  database
    .prepare("DELETE FROM flights WHERE id = @id")
    .run({ id });

  return { deleted: true, flight };
}

export function findHotels({ location, maxNightlyRate }) {
  const conditions = [];
  const params = {};

  if (location) {
    conditions.push("LOWER(location) LIKE LOWER(@location)");
    params.location = `%${location}%`;
  }

  if (maxNightlyRate) {
    conditions.push("nightly_rate <= @maxNightlyRate");
    params.maxNightlyRate = maxNightlyRate;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDatabase()
    .prepare(`SELECT * FROM hotels ${whereClause} ORDER BY rating DESC`)
    .all(params);

  return rows.map(mapHotel);
}

export function listTrips({ destination } = {}) {
  const conditions = [];
  const params = {};

  if (destination) {
    conditions.push("LOWER(destination) LIKE LOWER(@destination)");
    params.destination = `%${destination}%`;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDatabase()
    .prepare(`SELECT * FROM trips ${whereClause} ORDER BY total_estimate ASC`)
    .all(params);

  return rows.map(mapTrip);
}

export function listLocations({ category } = {}) {
  let query = `
    SELECT from_city AS name, 'city' AS type FROM flights
    UNION
    SELECT to_city AS name, 'city' AS type FROM flights
  `;

  if (category === "hotels") {
    query = `
      SELECT location AS name, 'area' AS type FROM hotels
    `;
  }

  if (category === "trips") {
    query = `
      SELECT destination AS name, 'destination' AS type FROM trips
    `;
  }

  const rows = getDatabase()
    .prepare(`SELECT DISTINCT name, type FROM (${query}) ORDER BY name ASC`)
    .all();

  return rows;
}

export function createBookingRecord({
  id,
  bookingReference,
  user,
  type,
  itemId,
  travelers,
  status,
  createdAt,
  // Supplied only by the MCP write path, from the verified delegated token.
  bookedByAgentId = null,
  bookedByAgentName = null
}) {
  const username = user.username || user.email || user.id;
  const item = findBookingItem(type, itemId);
  const bookingPrice = type === "flight" ? item.price : null;

  getDatabase()
    .prepare(
      `
        INSERT INTO bookings (
          id,
          booking_reference,
          user_id,
          username,
          type,
          item_id,
          travelers,
          booking_price,
          status,
          created_at,
          booked_by_agent_id,
          booked_by_agent_name
        ) VALUES (
          @id,
          @bookingReference,
          @userId,
          @username,
          @type,
          @itemId,
          @travelers,
          @bookingPrice,
          @status,
          @createdAt,
          @bookedByAgentId,
          @bookedByAgentName
        )
      `
    )
    .run({
      id,
      bookingReference,
      userId: user.id,
      username,
      type,
      itemId,
      travelers,
      bookingPrice,
      status,
      createdAt,
      bookedByAgentId,
      bookedByAgentName
    });

  return {
    id,
    bookingReference,
    userId: user.id,
    username,
    type,
    itemId,
    travelers,
    bookingPrice,
    status,
    createdAt,
    bookedByAgentId,
    bookedByAgentName
  };
}

export function findDuplicateBooking({ username, type, itemId }) {
  if (type !== "flight") {
    return getDatabase()
      .prepare(
        `
          SELECT id
          FROM bookings
          WHERE username = @username
            AND type = @type
            AND item_id = @itemId
            AND status != 'canceled'
          LIMIT 1
        `
      )
      .get({ username, type, itemId });
  }

  return getDatabase()
    .prepare(
      `
        SELECT bookings.id
        FROM bookings
        INNER JOIN flights booked_flight ON bookings.item_id = booked_flight.id
        INNER JOIN flights requested_flight ON requested_flight.id = @itemId
        WHERE bookings.username = @username
          AND bookings.type = 'flight'
          AND bookings.status != 'canceled'
          AND booked_flight.from_city = requested_flight.from_city
          AND booked_flight.to_city = requested_flight.to_city
          AND booked_flight.departure_time = requested_flight.departure_time
          AND booked_flight.arrival_time = requested_flight.arrival_time
          AND booked_flight.dates = requested_flight.dates
        LIMIT 1
      `
    )
    .get({ username, itemId });
}

export function listBookedFlights(username) {
  const rows = getDatabase()
    .prepare(
      `
        SELECT
          bookings.id AS booking_id,
          bookings.booking_reference,
          bookings.username,
          bookings.travelers,
          bookings.booking_price,
          bookings.status,
          bookings.created_at,
          bookings.booked_by_agent_id,
          bookings.booked_by_agent_name,
          flights.*
        FROM bookings
        INNER JOIN flights ON bookings.item_id = flights.id
        WHERE bookings.type = 'flight'
          AND bookings.username = @username
        ORDER BY bookings.created_at DESC
      `
    )
    .all({ username });

  return rows.map((row) => ({
    id: row.booking_id,
    bookingReference: row.booking_reference,
    username: row.username,
    travelers: row.travelers,
    status: row.status,
    createdAt: row.created_at,
    bookedByAgentId: row.booked_by_agent_id,
    bookedByAgentName: row.booked_by_agent_name,
    flight: {
      ...mapFlight(row),
      price: row.booking_price ?? row.price
    }
  }));
}

export function getBookedFlightById(bookingId) {
  const row = getDatabase()
    .prepare(
      `
        SELECT
          bookings.id AS booking_id,
          bookings.booking_reference,
          bookings.username,
          bookings.travelers,
          bookings.booking_price,
          bookings.status,
          bookings.created_at,
          bookings.booked_by_agent_id,
          bookings.booked_by_agent_name,
          flights.*
        FROM bookings
        INNER JOIN flights ON bookings.item_id = flights.id
        WHERE bookings.type = 'flight'
          AND bookings.id = @bookingId
        LIMIT 1
      `
    )
    .get({ bookingId });

  if (!row) {
    return null;
  }

  return {
    id: row.booking_id,
    bookingReference: row.booking_reference,
    username: row.username,
    travelers: row.travelers,
    status: row.status,
    createdAt: row.created_at,
    bookedByAgentId: row.booked_by_agent_id,
    bookedByAgentName: row.booked_by_agent_name,
    flight: {
      ...mapFlight(row),
      price: row.booking_price ?? row.price
    }
  };
}

export function updateBookedFlightPrice({ bookingId, username, price }) {
  const booking = getBookedFlightById(bookingId);

  if (!booking) {
    return null;
  }

  if (username && booking.username !== username) {
    return null;
  }

  if (booking.status === "canceled") {
    return null;
  }

  getDatabase()
    .prepare(
      `
        UPDATE bookings
        SET booking_price = @price
        WHERE id = @bookingId
          AND type = 'flight'
      `
    )
    .run({ bookingId, price });

  return getBookedFlightById(bookingId);
}

export function cancelBookedFlight({ bookingId, username, disableDealAlerts = true }) {
  const booking = getBookedFlightById(bookingId);

  if (!booking) {
    return null;
  }

  if (username && booking.username !== username) {
    return null;
  }

  if (booking.status === "canceled") {
    return booking;
  }

  const cancelBooking = getDatabase().transaction(() => {
    getDatabase()
      .prepare(
        `
          UPDATE bookings
          SET status = 'canceled'
          WHERE id = @bookingId
            AND type = 'flight'
        `
      )
      .run({ bookingId });

    if (disableDealAlerts) {
      getDatabase()
        .prepare(
          `
            UPDATE deal_alert_consents
            SET enabled = 0,
                updated_at = @updatedAt
            WHERE booking_id = @bookingId
          `
        )
        .run({
          bookingId,
          updatedAt: new Date().toISOString()
        });
    }
  });

  cancelBooking();

  return getBookedFlightById(bookingId);
}

export function transferDealAlertConsentBooking({
  fromBookingId,
  toBookingId,
  username,
  now
}) {
  const fromBooking = getBookedFlightById(fromBookingId);
  const toBooking = getBookedFlightById(toBookingId);

  if (!fromBooking || !toBooking) {
    return null;
  }

  if (username && (fromBooking.username !== username || toBooking.username !== username)) {
    return null;
  }

  const existingTargetConsent = getDatabase()
    .prepare(
      `
        SELECT id
        FROM deal_alert_consents
        WHERE booking_id = @toBookingId
          AND username = @username
        LIMIT 1
      `
    )
    .get({ toBookingId, username: fromBooking.username });

  const transferConsent = getDatabase().transaction(() => {
    if (existingTargetConsent) {
      getDatabase()
        .prepare(
          `
            DELETE FROM deal_alert_consents
            WHERE booking_id = @fromBookingId
              AND username = @username
          `
        )
        .run({ fromBookingId, username: fromBooking.username });

      getDatabase()
        .prepare(
          `
            UPDATE deal_alert_consents
            SET enabled = 1,
                updated_at = @updatedAt
            WHERE booking_id = @toBookingId
              AND username = @username
          `
        )
        .run({ toBookingId, username: fromBooking.username, updatedAt: now });

      return;
    }

    getDatabase()
      .prepare(
        `
          UPDATE deal_alert_consents
          SET booking_id = @toBookingId,
              enabled = 1,
              updated_at = @updatedAt
          WHERE booking_id = @fromBookingId
            AND username = @username
        `
      )
      .run({
        fromBookingId,
        toBookingId,
        username: fromBooking.username,
        updatedAt: now
      });
  });

  transferConsent();

  return getDealAlertConsent({ bookingId: toBookingId, username: fromBooking.username });
}

export function upsertDealAlertConsent({
  id,
  bookingId,
  username,
  routeFrom,
  routeTo,
  criteria,
  enabled,
  now
}) {
  const existing = getDatabase()
    .prepare(
      `
        SELECT id, created_at
        FROM deal_alert_consents
        WHERE booking_id = @bookingId
          AND username = @username
        LIMIT 1
      `
    )
    .get({ bookingId, username });

  const consentId = existing?.id || id;
  const createdAt = existing?.created_at || now;

  getDatabase()
    .prepare(
      `
        INSERT INTO deal_alert_consents (
          id,
          booking_id,
          username,
          route_from,
          route_to,
          criteria_json,
          enabled,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @bookingId,
          @username,
          @routeFrom,
          @routeTo,
          @criteriaJson,
          @enabled,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(booking_id, username) DO UPDATE SET
          route_from = excluded.route_from,
          route_to = excluded.route_to,
          criteria_json = excluded.criteria_json,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `
    )
    .run({
      id: consentId,
      bookingId,
      username,
      routeFrom,
      routeTo,
      criteriaJson: JSON.stringify(criteria && typeof criteria === "object" ? criteria : {}),
      enabled: enabled ? 1 : 0,
      createdAt,
      updatedAt: now
    });

  return getDealAlertConsent({ bookingId, username });
}

export function getDealAlertConsent({ bookingId, username }) {
  const row = getDatabase()
    .prepare(
      `
        SELECT *
        FROM deal_alert_consents
        WHERE booking_id = @bookingId
          AND username = @username
        LIMIT 1
      `
    )
    .get({ bookingId, username });

  return row ? mapDealAlertConsent(row) : null;
}

export function listEnabledDealAlertConsents(username) {
  const rows = getDatabase()
    .prepare(
      `
        SELECT
          deal_alert_consents.*,
          bookings.booking_reference,
          bookings.booking_price,
          flights.price AS flight_price,
          flights.currency
        FROM deal_alert_consents
        INNER JOIN bookings ON deal_alert_consents.booking_id = bookings.id
        INNER JOIN flights ON bookings.item_id = flights.id
        WHERE deal_alert_consents.username = @username
          AND deal_alert_consents.enabled = 1
          AND bookings.type = 'flight'
          AND bookings.status != 'canceled'
        ORDER BY deal_alert_consents.updated_at DESC
      `
    )
    .all({ username });

  return rows.map((row) => ({
    ...mapDealAlertConsent(row),
    bookingReference: row.booking_reference,
    currentPrice: row.booking_price ?? row.flight_price,
    currency: row.currency
  }));
}

export function listAllEnabledDealAlertConsents() {
  const rows = getDatabase()
    .prepare(
      `
        SELECT
          deal_alert_consents.*,
          bookings.user_id,
          bookings.travelers,
          bookings.booking_price,
          flights.price AS flight_price,
          flights.currency,
          flights.cabin,
          flights.dates,
          flights.departure_time
        FROM deal_alert_consents
        INNER JOIN bookings ON deal_alert_consents.booking_id = bookings.id
        INNER JOIN flights ON bookings.item_id = flights.id
        WHERE deal_alert_consents.enabled = 1
          AND bookings.type = 'flight'
          AND bookings.status != 'canceled'
        ORDER BY deal_alert_consents.updated_at DESC
      `
    )
    .all();

  return rows.map((row: any) => ({
    consent: mapDealAlertConsent(row),
    currentPrice: row.booking_price ?? row.flight_price,
    currentCabin: row.cabin,
    currentDates: row.dates,
    currentDepartureTime: row.departure_time,
    currency: row.currency,
    travelers: row.travelers,
    userId: row.user_id
  }));
}

function mapDealAlertConsent(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    username: row.username,
    routeFrom: row.route_from,
    routeTo: row.route_to,
    criteria: parseJsonObject(row.criteria_json),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
