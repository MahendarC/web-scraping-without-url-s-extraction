const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const fs = require("fs").promises;
const path = require("path");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

puppeteer.use(StealthPlugin());

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1"
];

const locations = ["A F Station Yelahanka", "Air Force Hospital", "Amruthahalli", "Anandnagar (Bangalore)", "Arabic College", "Attur", "Austin Town", "Banaswadi", "Bangalore Bazaar", "Benson Town", "Bhattarahalli", "BSF Campus Yelahanka", "Byatarayanapura", "C.V.Raman Nagar", "CMP Centre And School", "CRPF Campus Yelahanka", "Devasandra", "Doddagubbi", "Doddanekkundi", "Domlur"];
const categories = ["drill machine", "electric saw", "hand tools kit", "angle grinder", "hardware tools"];

async function humanScroll(page, containerSelector) {
  let previousHeight = 0;
  let scrollCount = 0;
  while (true) {
    const currentHeight = await page.evaluate(c => document.querySelector(c)?.scrollHeight || 0, containerSelector);
    if (currentHeight === previousHeight) break;
    const scrollStep = 100 + Math.floor(Math.random() * 100);
    await page.evaluate((c, step) => {
      const container = document.querySelector(c);
      if (container) container.scrollBy(0, step);
    }, containerSelector, scrollStep);
    await delay(2000 + Math.floor(Math.random() * 500));
    previousHeight = currentHeight;
    scrollCount++;
  }
  return scrollCount > 0;
}

async function scrapeLocationCategory(location, searchQuery) {
  const fullQuery = `${location} ${searchQuery}`.replace(/\s+/g, '+');
  const url = `https://www.google.com/maps/search/${fullQuery}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-geolocation"]
  });

  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(60000);

  const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  await page.setExtraHTTPHeaders({ "User-Agent": randomUserAgent });

  await page.evaluateOnNewDocument(() => {
    navigator.geolocation.getCurrentPosition = function (success) {
      success({
        coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 100 }
      });
    };
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    try {
      await page.click("[aria-label='Accept all']", { timeout: 5000 });
      await delay(1500);
    } catch {}

    const scrollContainer = ".m6QErb[aria-label]";
    const resultsPane = await page.$(scrollContainer);
    if (!resultsPane) throw new Error("Results pane not found");

    let data = [];
    if (await humanScroll(page, scrollContainer)) {
      let previousHeight = 0;
      while (true) {
        const items = await page.evaluate((container, userLocation, userCategory) => {
          const elements = document.querySelectorAll(".Nv2PK");
          if (!elements.length) return null;
          return Array.from(elements).map(el => {
            const phoneElements = Array.from(el.querySelectorAll("a[href^='tel:'], span.fontBodyMedium"))
              .map(e => e.textContent.trim())
              .filter(t => t && /^\+?\d[\d\s\-]{6,}$/.test(t));
            return {
              title: el.querySelector(".qBF1Pd")?.textContent.trim() || "",
              address: el.querySelector(".W4Efsd:last-child > .W4Efsd:nth-of-type(1) > span:last-child")?.textContent.replace(/·/g, "").trim() || "",
              website: el.querySelector("a.lcr4fd")?.getAttribute("href") || "",
              category: el.querySelector(".W4Efsd:last-child > .W4Efsd:nth-of-type(1) > span:first-child")?.textContent.replace(/·/g, "").trim() || "",
              phone: phoneElements[0] || "",
              rating: el.querySelector(".MW4etd")?.textContent.trim() || "",
              reviews: el.querySelector(".UY7F9")?.textContent.replace(/[()]/g, "").trim() || "",
              location: userLocation,
              acategory: userCategory
            };
          });
        }, scrollContainer, location, searchQuery);

        if (!items) break;
        data = [...new Map(data.concat(items).map(item => [item.title, item])).values()];
        console.log(`(${location} - ${searchQuery}) Found ${data.length} listings...`);

        await page.evaluate((container) => {
          const el = document.querySelector(container);
          if (el) el.scrollTo(0, el.scrollHeight);
        }, scrollContainer);

        await delay(1500);
        const newHeight = await page.evaluate((container) => document.querySelector(container)?.scrollHeight || 0, scrollContainer);
        if (newHeight === previousHeight) break;
        previousHeight = newHeight;
      }
    }

    if (!data.length) throw new Error("No data scraped");

    const folderPath = path.join(__dirname, "data_scraped");
    await fs.mkdir(folderPath, { recursive: true });
    const now = new Date();
    const dateTime = now.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
    const csvFileName = `${dateTime}_${location.replace(/ /g, "_")}_${searchQuery.replace(/ /g, "_")}.csv`;
    const csvFilePath = path.join(folderPath, csvFileName);

    const csvWriter = createCsvWriter({
      path: csvFilePath,
      header: [
        { id: "title", title: "Name" },
        { id: "address", title: "Address" },
        { id: "website", title: "Website" },
        { id: "category", title: "Category" },
        { id: "phone", title: "Phone" },
        { id: "rating", title: "Rating" },
        { id: "reviews", title: "Reviews" },
        { id: "location", title: "Location" },
        { id: "acategory", title: "ACategory" }
      ]
    });

    await csvWriter.writeRecords(data);
    console.log(`Saved ${data.length} results to: ${csvFilePath}`);
  } catch (error) {
    console.error(`(${location} - ${searchQuery}) Error:`, error.message);
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

(async () => {
  for (const location of locations) {
    for (const category of categories) {
      await scrapeLocationCategory(location, category);
    }
  }
})();
