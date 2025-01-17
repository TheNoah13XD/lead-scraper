import { Actor, ApifyClient, Dataset, RequestQueue } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { router } from './routes.js';

interface Input {
    startUrls: string[];
    maxRequestsPerCrawl: number;
}

await Actor.init();

export const client = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

export const extractUsernames = (uniqueSocialLinks: any[], platform: string) => {
    const regexMap: { [key: string]: RegExp } = {
        instagram: /instagram\.com\/([^/?]+)/,
        tiktok: /tiktok\.com\/@([^/?]+)/,
        twitter: /twitter\.com\/([^/?]+)/,
        youtube: /youtube\.com\/([^/?]+)/,
        twitch: /twitch\.tv\/([^/?]+)/,
        snapchat: /snapchat\.com\/add\/([^/?]+)/
    };

    const extractUsername = (url: string) => {
        const match = url.match(regexMap[platform]);
        return match ? match[1] : null;
    };

    return uniqueSocialLinks.reduce((usernames, link) => {
        const username = link && link.url ? extractUsername(link.url) : null;
        if (username) {
            usernames.push(username);
        }
        return usernames;
    }, [] as string[]);
};

export const extractEmails = (text: string) => {
    if (!text) return new Set<string>();
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    return new Set<string>((text.match(emailRegex) || []).map(email => email.trim()));
}

const extractLinktree = (text: string) => {
    if (!text) return new Set<string>();
    const linktreeRegex = /https?:\/\/(www\.)?linktr\.ee\/([^/?#]+)/g;
    return new Set<string>((text.match(linktreeRegex) || []).map(link => link.trim()));
}

const {
    startUrls = ['https://linktr.ee/whonoahexe'],
    maxRequestsPerCrawl = 100,
} = await Actor.getInput<Input>() ?? {} as Input;

const proxyConfiguration = await Actor.createProxyConfiguration();
const requestQueue = await RequestQueue.open();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
    },
    maxRequestsPerCrawl,
    preNavigationHooks: [async ({ request, log }) => {
        if (request.url.includes('instagram.com') || request.url.includes('tiktok.com')) {
            const url = request.url;
            const platform = request.url.includes('instagram.com') ? 'instagram' : 'tiktok';

            const [username] = extractUsernames([{ url }], platform);
            if (!username) {
                log.info(`No username found for ${platform}`);
                return;
            }

            const run = platform === 'instagram' ? await client.actor("apify/instagram-profile-scraper").call({ usernames: [username], resultsLimit: 1 }) : await client.actor("clockworks/tiktok-profile-scraper").call({ profiles: [username], resultsPerPage: 1 });
            const { items } = await client.dataset(run.defaultDatasetId).listItems();
            items.forEach(async (item) => {
                const bio = platform === 'instagram' ? item.biography : (item as any).authorMeta.signature;
                const externalUrl = platform === 'instagram' ? item.externalUrl : (item as any).authorMeta.bioLink;

                const linktree = new Set([...extractLinktree(bio as string), ...extractLinktree(externalUrl as string)]);
                if (linktree.size) {
                    const linktreeUrl = Array.from(linktree)[0];
                    log.info(`Linktree found: ${linktreeUrl}`);
                    await requestQueue.addRequest({ url: linktreeUrl });
                } else {
                    const email = Array.from(extractEmails(bio as string)).find(email => email.includes('@'));
                    if (email) {
                        log.info(`Email found: ${email}`);
                        await Dataset.pushData({ email, platform, username });
                    }
                }
            });
        }
    }],
    requestHandler: router,
    requestHandlerTimeoutSecs: 1800,
    maxRequestRetries: 1,
    headless: true,
    minConcurrency: 3,
});

await crawler.run(startUrls);

await Actor.exit();
