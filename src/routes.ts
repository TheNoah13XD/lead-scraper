import { Dataset, createPlaywrightRouter } from 'crawlee';
import { ApifyClient } from 'apify-client';
import dotenv from 'dotenv';

dotenv.config();

const client = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

const extractEmails = (text: string) => {
    if (!text) return new Set<string>();
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    return new Set<string>((text.match(emailRegex) || []).map(email => email.trim()));
}

const extractProfileData = async (page: any) => {
    return await page.evaluate(() => {
        const nameElement = document.querySelector('#profile-title') as HTMLElement;
        const profileName = nameElement?.innerText.trim() || 'Unknown';
        const pageTitle = document.title;

        const socialIcons = Array.from(document.querySelectorAll('a[data-testid="SocialIcon"]')).map(icon => ({
            title: icon.getAttribute('title') || 'Unknown',
            url: icon.getAttribute('href') || 'Unknown',
        }));

        const links = Array.from(document.querySelectorAll('a[data-testid="LinkButton"]')).map(anchor => ({
            title: anchor.querySelector('p')?.innerText.trim() || 'Unknown',
            url: anchor.getAttribute('href') || 'Unknown',
        }));

        const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        const emailsFromContent = new Set<string>((document.body.innerText.match(emailRegex) || []).map(email => email.trim()));

        return { pageTitle, profileName, socialIcons, links, emailsFromContent: Array.from(emailsFromContent) };
    });
};

const combineAndFilterLinks = (socialIcons: any[], links: any[], emails: Set<string>) => {
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

    return [...socialIcons, ...links].filter(link => {
        if (link.url && emailRegex.test(link.url)) {
            emails.add(link.url.replace(/^mailto:/, '').trim());
            return false;
        }
        return true;
    });
};

const separateLinks = (combinedLinks: any[]) => {
    const socialMediaDomains = ['instagram', 'tiktok', 'twitter', 'x.com', 'youtube', 'twitch', 'snapchat'];
    const isSocialMediaLink = (url: string) => socialMediaDomains.some(domain => url.includes(domain));

    const socialLinks = combinedLinks.filter(link => link.url && isSocialMediaLink(link.url));
    const otherLinks = combinedLinks.filter(link => link.url && !isSocialMediaLink(link.url));

    const uniqueSocialLinks = Array.from(new Set(socialLinks.map(link => JSON.stringify(link)))).map(link => JSON.parse(link));
    const uniqueOtherLinks = Array.from(new Set(otherLinks.map(link => JSON.stringify(link)))).map(link => JSON.parse(link));

    return { uniqueSocialLinks, uniqueOtherLinks };
};

const extractUsernames = (uniqueSocialLinks: any[], platform: string) => {
    const regexMap: { [key: string]: RegExp } = {
        instagram: /instagram\.com\/([^/?]+)/,
        tiktok: /tiktok\.com\/@([^/?]+)/
    };

    const extractUsername = (url: string) => {
        const match = url.match(regexMap[platform]);
        return match ? match[1] : null;
    };

    return uniqueSocialLinks.reduce((usernames, link) => {
        const username = link.url ? extractUsername(link.url) : null;
        if (username) {
            usernames.push(username);
        }
        return usernames;
    }, [] as string[]);
};

const fetchSocialMediaData = async (platform: string, input: any) => {
    const actorMap: { [key: string]: string } = {
        instagram: "apify/instagram-profile-scraper",
        tiktok: "clockworks/tiktok-profile-scraper",
        twitter: "apidojo/twitter-user-scraper",
        youtube: "streamers/youtube-scraper",
        snapchat: "tri_angle/snapchat-scraper",
    };

    if (!actorMap[platform]) {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    try {
        const run = await client.actor(actorMap[platform]).call(input);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        return items;
    } catch (error) {
        console.error(`Failed to fetch data for platform ${platform}:`, error);
        throw new Error(`Failed to fetch data for platform ${platform}`);
    }
};

const fetchTwitchData = async (page: any) => {
    return await page.evaluate(() => {
        const usernameElement = document.querySelector('h1.tw-title') as HTMLElement;
        const username = usernameElement?.innerText.trim() || 'Unknown';

        const followerCountElement = document.querySelector('span.fxviYd') as HTMLElement;
        const followerCount = followerCountElement?.innerText.trim() || 'Unknown';

        const bioElement = document.querySelector('p.ifSdA-D') as HTMLElement;
        const bio = bioElement?.innerText.trim() || 'Unknown';

        const socialLinks = Array.from(
            document.querySelectorAll('div.social-media-link')
        ).map(link => {
            const titleElement = link.querySelector('p.CoreText-sc-1txzju1-0') as HTMLElement;
            const title = titleElement?.innerText.trim() || 'Unknown';
        
            const anchor = link.querySelector('a') as HTMLAnchorElement;
            const url = anchor?.getAttribute('href') || 'Unknown';
        
            return { title, url };
        });

        const channelPanel = Array.from(
            document.querySelectorAll('div[data-test-selector="channel_panel_test_selector"]')
        ).map(panel => {
            const titleElement = panel.querySelector('[data-test-selector="title_test_selector"]') as HTMLElement;
            const title = titleElement?.innerText.trim() || 'Unknown';
    
            const linkElement = panel.querySelector('a[data-test-selector="link_url_test_selector"]') as HTMLAnchorElement;
            const href = linkElement?.getAttribute('href') || 'Unknown';
    
            const descriptionElement = panel.querySelector('[data-test-selector="description_test_selector"] p') as HTMLElement;
            const description = descriptionElement?.innerText.trim() || 'No description';
    
            const imageElement = panel.querySelector('img[data-test-selector="image_test_selector"]') as HTMLImageElement;
            const imageSrc = imageElement?.getAttribute('src') || 'No image';
    
            return { title, href, description, imageSrc };
        });

        return { username, followerCount, bio, socialLinks, channelPanel };
    });
};

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log }) => {
    const { pageTitle, profileName, socialIcons, links, emailsFromContent } = await extractProfileData(page);

    const emails: Set<string> = new Set(emailsFromContent);
    const combinedLinks = combineAndFilterLinks(socialIcons, links, emails);

    const { uniqueSocialLinks, uniqueOtherLinks } = separateLinks(combinedLinks);

    const [instagramUsernames, tiktokUsernames] = [
        extractUsernames(uniqueSocialLinks, 'instagram'),
        extractUsernames(uniqueSocialLinks, 'tiktok')
    ];

    const twitterUrls = uniqueSocialLinks.filter(link => link.url && link.url.includes('x.com')).map(link => link.url);
    const twitterStartUrls = twitterUrls.map(url => Array(5).fill(url)).flat();

    const youtubeUrls = uniqueSocialLinks.filter(link => link.url && link.url.includes('youtube')).map(link => link.url);
    const youtubeStartUrls = youtubeUrls.map(url => ({ url, method: 'GET' }));

    const snapchatStartUrls = uniqueSocialLinks.filter(link => link.url && link.url.includes('snapchat')).map(link => link.url);
    const twitchStartUrls = uniqueSocialLinks.filter(link => link.url && link.url.includes('twitch')).map(link => link.url);

    const [instagramResult, tiktokResult, twitterResult, youtubeResult, snapchatResult] = await Promise.all([
        instagramUsernames.length ? fetchSocialMediaData('instagram', { usernames: instagramUsernames, resultsLimit: 1 }) : [],
        tiktokUsernames.length ? fetchSocialMediaData('tiktok', { profiles: tiktokUsernames, resultsPerPage: 1 }) : [],
        twitterStartUrls.length ? fetchSocialMediaData('twitter', { startUrls: twitterStartUrls, getFollowers: false, getFollowing: false, getRetweeters: false }) : [],
        youtubeStartUrls.length ? fetchSocialMediaData('youtube', { startUrls: youtubeStartUrls, maxResults: 1, maxResultStreams: 0, maxResultsShorts: 0 }) : [],
        snapchatStartUrls.length ? fetchSocialMediaData('snapchat', { profilesInput: snapchatStartUrls }) : [],
    ]);

    const twitchResult = twitchStartUrls.length ? await page.goto(twitchStartUrls[0]) && await fetchTwitchData(page) : null;

    const instagram = instagramResult.length ? {
        url: instagramResult[0].url,
        username: instagramResult[0].username,
        displayName: instagramResult[0].fullName,
        followerCount: instagramResult[0].followersCount,
        bio: instagramResult[0].biography,
        emailsFound: Array.from(extractEmails(instagramResult[0].biography as string)),
    } : null;

    const tiktok = tiktokResult.length ? {
        url: (tiktokResult[0] as any).authorMeta.profileUrl,
        username: (tiktokResult[0] as any).authorMeta.name,
        displayName: (tiktokResult[0] as any).authorMeta.nickName,
        followerCount: (tiktokResult[0] as any).authorMeta.fans,
        likeCount: (tiktokResult[0] as any).authorMeta.heart,
        bio: (tiktokResult[0] as any).authorMeta.signature,
        emailsFound: Array.from(extractEmails((tiktokResult[0] as any).authorMeta.signature as string)),
    } : null;

    const twitter = twitterResult && twitterResult.length ? {
        url: twitterResult[0].url,
        username: twitterResult[0].userName,
        displayName: twitterResult[0].name,
        followerCount: twitterResult[0].followers,
        bio: twitterResult[0].description,
        location: twitterResult[0].location,
        linkedSite: (twitterResult[0].entities as any).url?.urls[0].expanded_url,
        emailsFound: Array.from(extractEmails(twitterResult[0].description as string)),
    } : null;

    const youtube = youtubeResult.length ? {
        url: youtubeResult[0].url,
        channelName: youtubeResult[0].channelName,
        userName: youtubeResult[0].channelId,
        subscriberCount: youtubeResult[0].numberOfSubscribers,
        channelDescription: youtubeResult[0].channelDescription,
        linkedSites: youtubeResult[0].channelDescriptionLinks,
        viewCount: youtubeResult[0].viewCount,
        country: youtubeResult[0].channelLocation,
        emailsFound: Array.from(extractEmails(youtubeResult[0].channelDescription as string)),
    } : null;

    const twitch = twitchResult ? {
        url: twitchStartUrls[0],
        username: twitchResult.username,
        followerCount: twitchResult.followerCount,
        bio: twitchResult.bio,
        linkedSites: twitchResult.socialLinks,
        chanelPanels: twitchResult.channelPanel,
        emailsFound: Array.from(extractEmails(twitchResult.bio as string)),
    } : null;

    const snapchat = snapchatResult.length ? {
        url: snapchatResult[0].profileUrl,
        username: snapchatResult[0].username1,
        bio: snapchatResult[0].profileDescription,
    } : null;

    log.info(`URL: ${request.url}, TITLE: ${pageTitle}`);
    log.info(`Profile Name: ${profileName}`);
    log.info(`Final email count: ${emails.size}`);

    await Dataset.pushData({
        url: request.loadedUrl,
        pageTitle,
        profileName,
        emails: Array.from(emails),
        socials: uniqueSocialLinks,
        otherLinks: uniqueOtherLinks,
        instagram,
        tiktok,
        twitter,
        youtube,
        twitch,
        snapchat,
    });
});
