import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");
// DB_PATH matches the API's and the MCP server's (src/db.ts), so a container
// can seed the shared volume. Unset, the database sits next to the API.
const configuredDbPath = process.env.DB_PATH?.trim() || "wayfinder.sqlite";
const dbPath = resolve(apiRoot, configuredDbPath);
const schemaPath = resolve(apiRoot, "schema.sql");
const forceSeed = process.argv.includes("--force") || process.argv.includes("-f");
// --if-missing seeds only a database without the catalogue tables, and leaves
// an existing one (and its bookings) alone. Containers run it on every start.
const seedIfMissing = process.argv.includes("--if-missing");

const flights = [
  {
    id: "flight-nbo-mba-01",
    from: "Nairobi",
    to: "Mombasa",
    airline: "Jambojet",
    departure_time: "07:30",
    arrival_time: "08:35",
    duration: "1h 05m",
    stops: 0,
    price: 78,
    currency: "USD",
    cabin: "Economy",
    dates: "Sep 21 - Sep 27",
    tags: JSON.stringify(["Domestic", "Morning"])
  },
  {
    id: "flight-nbo-add-01",
    from: "Nairobi",
    to: "Addis Ababa",
    airline: "Ethiopian Airlines",
    departure_time: "08:45",
    arrival_time: "10:50",
    duration: "2h 05m",
    stops: 0,
    price: 214,
    currency: "USD",
    cabin: "Economy",
    dates: "Sep 24 - Sep 30",
    tags: JSON.stringify(["Regional", "Nonstop"])
  },
  {
    id: "flight-mba-nbo-01",
    from: "Mombasa",
    to: "Nairobi",
    airline: "Jambojet",
    departure_time: "17:45",
    arrival_time: "18:50",
    duration: "1h 05m",
    stops: 0,
    price: 82,
    currency: "USD",
    cabin: "Economy",
    dates: "Sep 26 - Oct 02",
    tags: JSON.stringify(["Domestic", "Evening"])
  },
  {
    id: "flight-nbo-dxb-01",
    from: "Nairobi",
    to: "Dubai",
    airline: "Emirates",
    departure_time: "04:20",
    arrival_time: "10:25",
    duration: "5h 05m",
    stops: 0,
    price: 396,
    currency: "USD",
    cabin: "Economy",
    dates: "Oct 08 - Oct 16",
    tags: JSON.stringify(["Nonstop", "Popular"])
  },
  {
    id: "flight-nbo-kgl-01",
    from: "Nairobi",
    to: "Kigali",
    airline: "RwandAir",
    departure_time: "13:40",
    arrival_time: "14:15",
    duration: "1h 35m",
    stops: 0,
    price: 186,
    currency: "USD",
    cabin: "Economy",
    dates: "Oct 15 - Oct 21",
    tags: JSON.stringify(["Regional", "Quick trip"])
  },
  {
    id: "flight-nbo-mra-01",
    from: "Nairobi",
    to: "Maasai Mara",
    airline: "Safarilink",
    departure_time: "10:00",
    arrival_time: "10:45",
    duration: "45m",
    stops: 0,
    price: 198,
    currency: "USD",
    cabin: "Economy",
    dates: "Oct 22 - Oct 26",
    tags: JSON.stringify(["Safari", "Scenic"])
  },
  {
    id: "flight-nbo-lhr-01",
    from: "Nairobi",
    to: "London",
    airline: "Kenya Airways",
    departure_time: "23:30",
    arrival_time: "05:05",
    duration: "8h 35m",
    stops: 0,
    price: 614,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 05 - Nov 14",
    tags: JSON.stringify(["Nonstop", "Overnight"])
  },
  {
    id: "flight-nbo-hnd-01",
    from: "Nairobi",
    to: "Tokyo",
    airline: "Kenya Airways",
    departure_time: "13:20",
    arrival_time: "22:35",
    duration: "19h 45m",
    stops: 1,
    price: 1148,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 09 - Nov 22",
    tags: JSON.stringify(["One stop", "Long haul"])
  },
  {
    id: "flight-nbo-ams-01",
    from: "Nairobi",
    to: "Amsterdam",
    airline: "KLM",
    departure_time: "23:55",
    arrival_time: "06:20",
    duration: "8h 25m",
    stops: 0,
    price: 648,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 12 - Nov 20",
    tags: JSON.stringify(["Nonstop", "Europe"])
  },
  {
    id: "flight-nbo-dxb-02",
    from: "Nairobi",
    to: "Dubai",
    airline: "Kenya Airways",
    departure_time: "15:35",
    arrival_time: "21:40",
    duration: "5h 05m",
    stops: 0,
    price: 352,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 14 - Nov 21",
    tags: JSON.stringify(["Best value", "Nonstop"])
  },
  {
    id: "flight-nbo-jnb-01",
    from: "Nairobi",
    to: "Johannesburg",
    airline: "Kenya Airways",
    departure_time: "09:50",
    arrival_time: "12:55",
    duration: "4h 05m",
    stops: 0,
    price: 368,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 18 - Nov 24",
    tags: JSON.stringify(["Nonstop", "Business friendly"])
  },
  {
    id: "flight-lhr-nbo-01",
    from: "London",
    to: "Nairobi",
    airline: "British Airways",
    departure_time: "18:40",
    arrival_time: "06:20",
    duration: "8h 40m",
    stops: 0,
    price: 672,
    currency: "USD",
    cabin: "Economy",
    dates: "Nov 21 - Nov 29",
    tags: JSON.stringify(["Nonstop", "Evening"])
  },
  {
    id: "flight-nbo-doh-01",
    from: "Nairobi",
    to: "Doha",
    airline: "Qatar Airways",
    departure_time: "03:55",
    arrival_time: "09:20",
    duration: "5h 25m",
    stops: 0,
    price: 432,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 03 - Dec 12",
    tags: JSON.stringify(["Nonstop", "Carry-on included"])
  },
  {
    id: "flight-nbo-lhr-02",
    from: "Nairobi",
    to: "London",
    airline: "Qatar Airways",
    departure_time: "03:55",
    arrival_time: "16:10",
    duration: "13h 50m",
    stops: 1,
    price: 528,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 05 - Dec 15",
    tags: JSON.stringify(["Good price", "One stop"])
  },
  {
    id: "flight-nbo-ist-01",
    from: "Nairobi",
    to: "Istanbul",
    airline: "Turkish Airlines",
    departure_time: "16:05",
    arrival_time: "23:20",
    duration: "7h 15m",
    stops: 0,
    price: 556,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 10 - Dec 19",
    tags: JSON.stringify(["Nonstop", "Europe"])
  },
  {
    id: "flight-nbo-znz-01",
    from: "Nairobi",
    to: "Zanzibar",
    airline: "Kenya Airways",
    departure_time: "11:15",
    arrival_time: "12:40",
    duration: "1h 25m",
    stops: 0,
    price: 208,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 18 - Dec 27",
    tags: JSON.stringify(["Beach trip", "Nonstop"])
  },
  {
    id: "flight-nbo-uku-01",
    from: "Nairobi",
    to: "Diani",
    airline: "Safarilink",
    departure_time: "09:20",
    arrival_time: "10:35",
    duration: "1h 15m",
    stops: 0,
    price: 124,
    currency: "USD",
    cabin: "Economy",
    dates: "Dec 22 - Dec 30",
    tags: JSON.stringify(["Beach trip", "Domestic"])
  }
];

const hotels = [
  {
    id: "hotel-nairobi-westlands",
    name: "Westlands Skyline Hotel",
    location: "Nairobi Westlands",
    nightly_rate: 138,
    currency: "USD",
    rating: 9.0,
    amenities: JSON.stringify(["Rooftop pool", "Business centre", "Free WiFi"])
  },
  {
    id: "hotel-nairobi-karen",
    name: "Karen Forest Lodge",
    location: "Nairobi Karen",
    nightly_rate: 172,
    currency: "USD",
    rating: 9.3,
    amenities: JSON.stringify(["Garden grounds", "Restaurant", "Airport shuttle"])
  },
  {
    id: "hotel-nairobi-cbd",
    name: "Kenyatta Avenue Suites",
    location: "Nairobi CBD",
    nightly_rate: 96,
    currency: "USD",
    rating: 8.5,
    amenities: JSON.stringify(["Central location", "Breakfast", "Fitness centre"])
  },
  {
    id: "hotel-nairobi-jkia",
    name: "JKIA Transit Hotel",
    location: "Nairobi Airport",
    nightly_rate: 88,
    currency: "USD",
    rating: 8.3,
    amenities: JSON.stringify(["Airport transfer", "24h reception", "Late checkout"])
  },
  {
    id: "hotel-mombasa-nyali",
    name: "Nyali Beach Resort",
    location: "Mombasa Nyali",
    nightly_rate: 142,
    currency: "USD",
    rating: 9.1,
    amenities: JSON.stringify(["Beachfront", "Pool", "Spa"])
  },
  {
    id: "hotel-diani-beach",
    name: "Diani Reef Retreat",
    location: "Diani Beach",
    nightly_rate: 164,
    currency: "USD",
    rating: 9.4,
    amenities: JSON.stringify(["Ocean view", "Water sports", "Restaurant"])
  },
  {
    id: "hotel-maasai-mara-camp",
    name: "Mara Riverside Camp",
    location: "Maasai Mara",
    nightly_rate: 285,
    currency: "USD",
    rating: 9.5,
    amenities: JSON.stringify(["Game drives", "Full board", "Guided walks"])
  },
  {
    id: "hotel-zanzibar-stonetown",
    name: "Stone Town Harbour House",
    location: "Zanzibar Stone Town",
    nightly_rate: 118,
    currency: "USD",
    rating: 8.8,
    amenities: JSON.stringify(["Historic quarter", "Rooftop dining", "Airport transfer"])
  },
  {
    id: "hotel-london-southbank",
    name: "South Bank Riverside Hotel",
    location: "London South Bank",
    nightly_rate: 214,
    currency: "USD",
    rating: 9.0,
    amenities: JSON.stringify(["Riverside location", "Fitness centre", "Concierge"])
  },
  {
    id: "hotel-dubai-marina",
    name: "Dubai Marina Towers",
    location: "Dubai Marina",
    nightly_rate: 178,
    currency: "USD",
    rating: 8.9,
    amenities: JSON.stringify(["Marina views", "Pool", "Gym"])
  }
];

const trips = [
  {
    id: "trip-mara-safari",
    title: "Maasai Mara safari escape",
    destination: "Maasai Mara",
    flight_id: "flight-nbo-mra-01",
    hotel_id: "hotel-maasai-mara-camp",
    status: "planning",
    total_estimate: 1338,
    currency: "USD"
  },
  {
    id: "trip-diani-beach-week",
    title: "Diani beach week",
    destination: "Diani",
    flight_id: "flight-nbo-uku-01",
    hotel_id: "hotel-diani-beach",
    status: "saved",
    total_estimate: 944,
    currency: "USD"
  },
  {
    id: "trip-zanzibar-getaway",
    title: "Zanzibar island getaway",
    destination: "Zanzibar",
    flight_id: "flight-nbo-znz-01",
    hotel_id: "hotel-zanzibar-stonetown",
    status: "planning",
    total_estimate: 798,
    currency: "USD"
  },
  {
    id: "trip-mombasa-coast",
    title: "Mombasa coast break",
    destination: "Mombasa",
    flight_id: "flight-nbo-mba-01",
    hotel_id: "hotel-mombasa-nyali",
    status: "saved",
    total_estimate: 646,
    currency: "USD"
  },
  {
    id: "trip-london-city",
    title: "London city break",
    destination: "London",
    flight_id: "flight-nbo-lhr-01",
    hotel_id: "hotel-london-southbank",
    status: "planning",
    total_estimate: 1470,
    currency: "USD"
  },
  {
    id: "trip-dubai-stopover",
    title: "Dubai stopover",
    destination: "Dubai",
    flight_id: "flight-nbo-dxb-02",
    hotel_id: "hotel-dubai-marina",
    status: "saved",
    total_estimate: 886,
    currency: "USD"
  }
];

if (!existsSync(dirname(dbPath))) {
  mkdirSync(dirname(dbPath), { recursive: true });
}

if (forceSeed && !seedIfMissing) {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }
}

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const insertFlightSql = `
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
    @departure_time,
    @arrival_time,
    @duration,
    @stops,
    @price,
    @currency,
    @cabin,
    @dates,
    @tags
  )
`;

const insertHotelSql = `
  INSERT INTO hotels (
    id,
    name,
    location,
    nightly_rate,
    currency,
    rating,
    amenities
  ) VALUES (
    @id,
    @name,
    @location,
    @nightly_rate,
    @currency,
    @rating,
    @amenities
  )
`;

const insertTripSql = `
  INSERT INTO trips (
    id,
    title,
    destination,
    flight_id,
    hotel_id,
    status,
    total_estimate,
    currency
  ) VALUES (
    @id,
    @title,
    @destination,
    @flight_id,
    @hotel_id,
    @status,
    @total_estimate,
    @currency
  )
`;

function hasCatalogueTables() {
  const present = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  );

  return ["flights", "hotels", "trips"].every((table) => present.has(table));
}

const seed = db.transaction(() => {
  if (seedIfMissing && hasCatalogueTables()) {
    return false;
  }

  db.exec(readFileSync(schemaPath, "utf8"));

  // Prepared after the schema runs: the tables do not exist before it.
  const insertFlight = db.prepare(insertFlightSql);
  const insertHotel = db.prepare(insertHotelSql);
  const insertTrip = db.prepare(insertTripSql);

  for (const flight of flights) {
    insertFlight.run(flight);
  }

  for (const hotel of hotels) {
    insertHotel.run(hotel);
  }

  for (const trip of trips) {
    insertTrip.run(trip);
  }

  return true;
});

// IMMEDIATE takes the write lock before the check, so two processes starting
// on a fresh volume cannot both decide to seed.
const seeded = seed.immediate();
db.close();

console.log(
  seeded
    ? `Seeded SQLite database at ${dbPath}${forceSeed ? " after force reset" : ""}`
    : `SQLite database at ${dbPath} already has the catalogue; left unchanged`
);
