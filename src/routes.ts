import { Dataset, createPlaywrightRouter } from 'crawlee';
import { ApifyClient } from 'apify-client';
import dotenv from 'dotenv';

dotenv.config();

const client = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

const extractProfileData = async (page: any) => {
    return await page.evaluate(() => {
        const nameElement = document.querySelector('#profile-title') as HTMLElement;
        const profileName = nameElement?.innerText.trim() || 'Unknown';
        const pageTitle = document.title;
        const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

        const socialIcons = Array.from(document.querySelectorAll('a[data-testid="SocialIcon"]')).map(icon => ({
            title: icon.getAttribute('title') || 'Unknown',
            url: icon.getAttribute('href') || 'Unknown',
        }));

        const links = Array.from(document.querySelectorAll('a[data-testid="LinkButton"]')).map(anchor => ({
            title: anchor.querySelector('p')?.innerText.trim() || 'Unknown',
            url: anchor.getAttribute('href') || 'Unknown',
        }));

        const emailsFromContent = new Set<string>(
            (document.body.innerText.match(emailRegex) || []).map(email => email.trim())
        );

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
    const socialMediaDomains = ['instagram', 'tiktok', 'twitter', 'youtube', 'twitch', 'snapchat'];
    const isSocialMediaLink = (url: string) => socialMediaDomains.some(domain => url.includes(domain));

    const socialLinks = combinedLinks.filter(link => isSocialMediaLink(link.url));
    const otherLinks = combinedLinks.filter(link => !isSocialMediaLink(link.url));

    const uniqueSocialLinks = Array.from(new Set(socialLinks.map(link => JSON.stringify(link)))).map(link => JSON.parse(link));
    const uniqueOtherLinks = Array.from(new Set(otherLinks.map(link => JSON.stringify(link)))).map(link => JSON.parse(link));

    return { uniqueSocialLinks, uniqueOtherLinks };
};

const extractInstagramUsernames = (uniqueSocialLinks: any[]) => {
    const extractUsername = (url: string) => {
        const match = url.match(/instagram\.com\/([^/?]+)/);
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

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log }) => {
    const { pageTitle, profileName, socialIcons, links, emailsFromContent } = await extractProfileData(page);
    const emails: Set<string> = new Set(emailsFromContent);
    const combinedLinks = combineAndFilterLinks(socialIcons, links, emails);
    const { uniqueSocialLinks, uniqueOtherLinks } = separateLinks(combinedLinks);
    const instagramUsernames = extractInstagramUsernames(uniqueSocialLinks);

    let instagramResult;

    if (instagramUsernames.length) {
        const run = await client.actor("apify/instagram-profile-scraper").call({ usernames: instagramUsernames });
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        instagramResult = items;
    }

    log.info(`URL: ${request.url}, TITLE: ${pageTitle}`);
    log.info(`Profile Name: ${profileName}`);
    log.info(`Final email count: ${emails.size}`);
    log.info(`Instagram result: ${JSON.stringify(instagramResult)}`);

    await Dataset.pushData({
        url: request.loadedUrl,
        pageTitle,
        profileName,
        emails: Array.from(emails),
        socials: uniqueSocialLinks,
        otherLinks: uniqueOtherLinks,
        instagramResult,
    });
});
