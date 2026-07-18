import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import zlib from 'zlib';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APPS_JSON_PATH = path.join(__dirname, '../src/data/apps.json');

async function fetchInternal(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

async function fetchReviews(appId) {
    // Fetch up to 50 reviews (default is often 50, but explicit limit is safer if we want more/less, max is usually 500 for RSS but let's start with 50 as 'all latest')
    // The user asked for "all", so let's try a reasonable chunk like 50 or 100. Let's use 100.
    const url = `https://itunes.apple.com/jp/rss/customerreviews/id=${appId}/sortBy=mostRecent/limit=50/json`;
    try {
        const data = await fetchInternal(url);

        if (!data.feed || !data.feed.entry) {
            return [];
        }

        // Handle case where entry is a single object instead of an array
        const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];

        const reviews = entries
            .filter(entry => {
                // Skip entries that are not reviews (sometimes the first entry is the app info itself, though typically in this feed format it's cleaner, but good to be safe check existence of rating)
                return entry['im:rating'] && parseInt(entry['im:rating'].label) >= 4; // Filter 4 or 5 stars
            })
            .map(entry => ({
                id: entry.id.label,
                title: entry.title.label,
                content: entry.content.label,
                rating: parseInt(entry['im:rating'].label),
                author: entry.author.name.label
            }));
        // Removed .slice(0, 3) to get all matching reviews from the feed

        return reviews;
    } catch (error) {
        // Some apps might not have reviews or feed might differ
        console.warn(`Warning: Failed to fetch reviews for app ID ${appId}:`, error.message);
        return [];
    }
}

async function getAppStoreConnectToken() {
    const issuerId = process.env.APP_STORE_ISSUER_ID;
    const keyId = process.env.APP_STORE_KEY_ID;
    const privateKeyPath = process.env.APP_STORE_PRIVATE_KEY_PATH;
    const privateKeyRaw = process.env.APP_STORE_PRIVATE_KEY;

    if (!issuerId || !keyId || (!privateKeyPath && !privateKeyRaw)) {
        console.warn('App Store Connect API credentials not found in .env. Skipping download count update.');
        return null;
    }

    try {
        const privateKey = privateKeyRaw ? privateKeyRaw.replace(/\\n/g, '\n') : await fs.readFile(privateKeyPath, 'utf8');
        const payload = {
            iss: issuerId,
            exp: Math.floor(Date.now() / 1000) + 10 * 60, // 10 minutes
            aud: 'appstoreconnect-v1'
        };
        return jwt.sign(payload, privateKey, { algorithm: 'ES256', keyid: keyId });
    } catch (error) {
        console.error('Failed to generate App Store Connect token:', error.message);
        return null;
    }
}

async function fetchReportDownloads(token, vendorNumber, frequency, reportDate) {
    const url = `https://api.appstoreconnect.apple.com/v1/salesReports?filter[frequency]=${frequency}&filter[reportDate]=${reportDate}&filter[reportSubType]=SUMMARY&filter[reportType]=SALES&filter[vendorNumber]=${vendorNumber}`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            if (response.status !== 404 && response.status !== 400) {
                console.error(`Failed to fetch ${frequency} report for ${reportDate}: ${response.status} ${response.statusText}`);
            }
            return [];
        }

        const arrayBuffer = await response.arrayBuffer();
        const decompressed = zlib.gunzipSync(Buffer.from(arrayBuffer)).toString('utf-8');
        
        const lines = decompressed.split('\n');
        if (lines.length < 2) return [];

        const headers = lines[0].split('\t');
        const appleIdIndex = headers.indexOf('Apple Identifier');
        const unitsIndex = headers.indexOf('Units');
        const productTypeIndex = headers.indexOf('Product Type Identifier');

        if (appleIdIndex === -1 || unitsIndex === -1 || productTypeIndex === -1) return [];

        const downloads = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            if (cols.length > Math.max(unitsIndex, productTypeIndex)) {
                const type = cols[productTypeIndex];
                // Exclude updates (starts with 7) and redownloads (starts with 3)
                if (type && !type.startsWith('7') && !type.startsWith('3')) {
                    downloads.push({
                        appleId: cols[appleIdIndex],
                        units: parseInt(cols[unitsIndex], 10)
                    });
                }
            }
        }
        return downloads;
    } catch (error) {
        console.error(`Error fetching/parsing ${frequency} report for ${reportDate}:`, error.message);
        return [];
    }
}

async function getLifetimeDownloadsMap(token, vendorNumber) {
    const downloadsMap = new Map();
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    // You can change startYear based on your first app's release year.
    const startYear = 2020; 

    console.log(`Fetching App Store Connect reports from ${startYear} to ${currentYear}...`);

    for (let year = startYear; year <= currentYear; year++) {
        if (year < currentYear) {
            console.log(`Fetching YEARLY report for ${year}...`);
            const records = await fetchReportDownloads(token, vendorNumber, 'YEARLY', year.toString());
            for (const record of records) {
                if (!isNaN(record.units)) {
                    const current = downloadsMap.get(record.appleId) || 0;
                    downloadsMap.set(record.appleId, current + record.units);
                }
            }
        } else {
            for (let month = 1; month <= currentMonth; month++) {
                const reportDate = `${year}-${String(month).padStart(2, '0')}`;
                console.log(`Fetching MONTHLY report for ${reportDate}...`);
                const records = await fetchReportDownloads(token, vendorNumber, 'MONTHLY', reportDate);
                for (const record of records) {
                    if (!isNaN(record.units)) {
                        const current = downloadsMap.get(record.appleId) || 0;
                        downloadsMap.set(record.appleId, current + record.units);
                    }
                }
            }
        }
    }
    return downloadsMap;
}

async function updateApps() {
    console.log('Reading apps.json...');
    const appsData = JSON.parse(await fs.readFile(APPS_JSON_PATH, 'utf-8'));

    // Extract IDs
    const appIds = [];
    const appMap = new Map();

    for (const app of appsData) {
        if (!app.appStoreLink) continue;

        // Extract ID from URL (e.g., https://.../id123456789)
        const match = app.appStoreLink.match(/\/id(\d+)/);
        if (match && match[1]) {
            const id = match[1];
            appIds.push(id);
            appMap.set(id, app);
        }
    }

    if (appIds.length === 0) {
        console.log('No App Store links found.');
        return;
    }

    // --- App Store Connect API Download Counts ---
    const token = await getAppStoreConnectToken();
    const vendorNumber = process.env.APP_STORE_VENDOR_NUMBER;
    let downloadsMap = new Map();

    if (token && vendorNumber) {
        downloadsMap = await getLifetimeDownloadsMap(token, vendorNumber);
    } else if (token && !vendorNumber) {
        console.warn('APP_STORE_VENDOR_NUMBER is not set in .env. Skipping download count update.');
    }

    console.log(`Found ${appIds.length} apps. Fetching data from iTunes Search API...`);

    // Fetch data in batches (iTunes API might have limits, but 20 is usually fine)
    // We can fetch multiple IDs at once: id=1,2,3
    const idsString = appIds.join(',');
    const apiUrl = `https://itunes.apple.com/jp/lookup?id=${idsString}`;

    try {
        const data = await fetchInternal(apiUrl);

        if (!data.results || data.results.length === 0) {
            console.log('No results returned from API.');
            return;
        }

        console.log(`API returned ${data.results.length} results. Updating data...`);

        for (const result of data.results) {
            const id = String(result.trackId);
            const app = appMap.get(id);

            if (app) {
                // Update fields
                app.name = result.trackName || app.name;
                app.description = result.description || app.description;

                // Get high-res icon (artworkUrl512 or 100)
                app.iconPlaceholder = result.artworkUrl512 || result.artworkUrl100 || app.iconPlaceholder;

                // Ratings
                app.rating = result.averageUserRating;
                app.ratingCount = result.userRatingCount;

                // Screenshots
                if (result.screenshotUrls && result.screenshotUrls.length > 0) {
                    app.images = result.screenshotUrls;
                }

                // Fetch Reviews
                console.log(`Fetching reviews for ${app.name}...`);
                const reviews = await fetchReviews(id);
                if (reviews.length > 0) {
                    app.reviews = reviews;
                }

                // Update Downloads
                if (downloadsMap.has(id)) {
                    app.downloads = downloadsMap.get(id);
                    console.log(`Updated downloads: ${app.downloads}`);
                }

                console.log(`Updated: ${app.name} (${reviews.length} reviews added)`);
            }
        }

        // Write back
        await fs.writeFile(APPS_JSON_PATH, JSON.stringify(appsData, null, 4), 'utf-8');
        console.log('Successfully updated apps.json');

    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

updateApps();
