const Apify = require('apify');
const placesCrawler = require('./places_crawler');
const resultJsonSchema = require('./result_item_schema');
const _ = require('lodash');
const { log } = Apify.utils;
const { getGeolocation, findPointsInPolygon } = require('./polygon');

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    const {
        startUrls, searchString, searchStringsArray, proxyConfig, lat, lng, maxCrawledPlaces, regularTestRun,
        includeReviews = true, includeImages = true, includeHistogram = true, includeOpeningHours = true,
        walker, debug, country, state, city, zoom = 10
    } = input;

    if (debug) log.setLevel(log.LEVELS.DEBUG);
    if (!searchString && !searchStringsArray && !startUrls) throw new Error('Attribute startUrls or searchString or searchStringsArray is missing in input.');
    if (proxyConfig && proxyConfig.apifyProxyGroups
        && (proxyConfig.apifyProxyGroups.includes('GOOGLESERP') || proxyConfig.apifyProxyGroups.includes('GOOGLE_SERP'))) {
        throw new Error('It is not possible to crawl google places with GOOGLE SERP proxy group. Please use a different one and rerun crawler.');
    }

    if (!startUrls) log.info('Scraping Google Places for search string:', searchString || searchStringsArray.join('; '));

    // save geolocation to keyval
    let geo = await Apify.getValue('GEO');
    Apify.events.on('migrating', async () => {
        await Apify.setValue('GEO', geo);
    });

    const startRequests = [];
    const startUrlSearches = [];
    if (lat || lng) {
        if (!lat || !lng) throw new Error('You have to defined lat and lng!');
        startUrlSearches.push(`https://www.google.com/maps/@${lat},${lng},${zoom}z/search`);
    } else if (country || state || city) {
        geo = geo || await getGeolocation({ country, state, city });

        let points = [];
        points = await findPointsInPolygon(geo, zoom, points);
        for (const point of points) {
            startUrlSearches.push(`https://www.google.com/maps/@${point.lat},${point.lon},${zoom}z/search`);
        }
    } else {
        startUrlSearches.push('https://www.google.com/maps/search/')
    }

    if (walker && searchString) {
        const { zoom, step, bounds } = walker;
        const { northeast, southwest } = bounds;
        log.info(`Using walker mode, generating pieces of map to walk with step ${step}, zoom ${step} and bounds ${JSON.stringify(bounds)}.`);
        /**
         * The hidden feature, with walker you can search business in specific square on map.
         */
        // Generate URLs to walk
        for (let walkerLng = northeast.lng; walkerLng >= southwest.lng; walkerLng = walkerLng - step) {
            for (let walkerLat = northeast.lat; walkerLat >= southwest.lat; walkerLat = walkerLat - step) {
                startRequests.push({
                    url: `https://www.google.com/maps/@${walkerLat},${walkerLng},${zoom}z/search`,
                    userData: { label: 'startUrl', searchString },
                });
            }
        }
    } else if (startUrls) {
        for (const url of startUrls) {
            startRequests.push({
                ...url,
                userData: { label: 'startUrl', searchString: null }
            });
        }
    } else if (searchString || searchStringsArray) {
        if (searchStringsArray && !_.isArray(searchStringsArray)) throw new Error('Attribute searchStringsArray has to be an array.');
        const searches = searchStringsArray || [searchString];
        for (const search of searches) {
            /**
             * User can use place_id:<Google place ID> as search query
             * TODO: Move place id to separate fields, once we have dependent fields. Than user can fill placeId or search query.
             */
            if (search.includes('place_id:')) {
                log.info(`Place ID found in search query. We will extract data from ${search}.`);
                const cleanSearch = search.slice(0, search.indexOf("place_id")).trim().replace(/\s+/g, "+")
                const placeId = cleanSearch.match(/place_id\:(.*)/)[1];
                startRequests.push({
                    url: `https://www.google.com/maps/search/?api=1&query=${cleanSearch}&query_place_id=${placeId}`,
                    uniqueKey: placeId,
                    userData: { label: 'detail', searchString },
                });
            } else {
                for (const startUrlSearch of startUrlSearches) {
                    startRequests.push({
                        url: startUrlSearch,
                        uniqueKey: `${startUrlSearch}+${search}`,
                        userData: { label: 'startUrl', searchString: search, geo }
                    });
                }
            }
        }
    }

    log.info('Start urls are', startRequests.map(r => r.url));
    const requestQueue = await Apify.openRequestQueue();

    for (const request of startRequests) {
        await requestQueue.addRequest(request);
    }

    const puppeteerPoolOptions = {
        launchPuppeteerOptions: {
            headless: true,
        },
        maxOpenPagesPerInstance: 1,
    };
    if (proxyConfig) {
        if (proxyConfig.useApifyProxy) {
            const proxyUrl = Apify.getApifyProxyUrl({
                groups: proxyConfig.apifyProxyGroups,
                country: proxyConfig.apifyProxyCountry
            });
            log.info(`Constructed proxy url: ${proxyUrl}`);
            puppeteerPoolOptions.launchPuppeteerOptions.proxyUrl = proxyUrl;
        }
        if (proxyConfig.proxyUrls && proxyConfig.proxyUrls.length > 0) {
            puppeteerPoolOptions.proxyUrls = proxyConfig.proxyUrls;
        }
    }

    // Create and run crawler
    const crawler = placesCrawler.setUpCrawler(puppeteerPoolOptions, requestQueue,
        maxCrawledPlaces, input);
    await crawler.run();

    if (regularTestRun) {
        const { defaultDatasetId: datasetId } = Apify.getEnv();
        await Apify.call('drobnikj/check-crawler-results', {
            datasetId,
            options: {
                minOutputtedPages: 5,
                jsonSchema: resultJsonSchema,
                notifyTo: 'jakub.drobnik@apify.com',
            },
        });
    }

    log.info('Done!');
});
