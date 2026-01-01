import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

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
