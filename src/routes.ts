import { Dataset, createPlaywrightRouter } from 'crawlee';
import { ApifyClient } from 'apify-client';
import dotenv from 'dotenv';

dotenv.config();

const client = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

const extractEmails = (text: string) => {
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
        if (emailRegex.test(link.url)) {
            emails.add(link.url.replace(/^mailto:/, '').trim());
            return false;
        }
        return true;
    });
};

const separateLinks = (combinedLinks: any[]) => {
    const socialMediaDomains = ['instagram', 'tiktok', 'twitter', 'x.com', 'youtube', 'twitch', 'snapchat'];
    const isSocialMediaLink = (url: string) => socialMediaDomains.some(domain => url.includes(domain));

    const socialLinks = combinedLinks.filter(link => isSocialMediaLink(link.url));
    const otherLinks = combinedLinks.filter(link => !isSocialMediaLink(link.url));

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
        const username = extractUsername(link.url);
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
        twitter: "memo23/apify-twitter-profile-scraper",
        youtube: "streamers/youtube-scraper",
        snapchat: "tri_angle/snapchat-scraper",
    };

    const run = await client.actor(actorMap[platform]).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items;
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

    const twitterStartUrls = uniqueOtherLinks.filter(link => link.url.includes('x.com')).map(link => link.url);
    const youtubeStartUrls = uniqueOtherLinks.filter(link => link.url.includes('youtube')).map(link => link.url);
    const snapchatStartUrls = uniqueOtherLinks.filter(link => link.url.includes('snapchat')).map(link => link.url);

    const [instagramResult, tiktokResult, twitterResult, youtubeResult, snapchatResult] = await Promise.all([
        instagramUsernames.length ? fetchSocialMediaData('instagram', { usernames: instagramUsernames, resultsLimit: 5 }) : [],
        tiktokUsernames.length ? fetchSocialMediaData('tiktok', { profiles: tiktokUsernames, resultsPerPage: 2 }) : [],
        twitterStartUrls.length ? fetchSocialMediaData('twitter', { startUrls: twitterStartUrls }) : [],
        youtubeStartUrls.length ? fetchSocialMediaData('youtube', { startUrls: youtubeStartUrls, maxResults: 1 }) : [],
        snapchatStartUrls.length ? fetchSocialMediaData('snapchat', { profilesInput: snapchatStartUrls }) : [],
    ]);

    const bioEmails = extractEmails(instagramResult.map((item: any) => item.biography).join(' ') + 
                        tiktokResult.map((item: any) => item.authorMeta.signature).join(' ') +
                        twitterResult.map((item: any) => item.author.description).join(' ') + 
                        youtubeResult.map((item: any) => item.channelDescription).join(' ') +
                        snapchatResult.map((item: any) => item.profileDescription).join(' '));
    bioEmails.forEach(email => emails.add(email));

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
        instagramResult,
        tiktokResult,
        twitterResult,
        youtubeResult,
        snapchatResult,
    });
});
