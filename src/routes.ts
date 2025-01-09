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
    const socialMediaDomains = ['instagram', 'tiktok', 'twitter', 'x.com', 'youtube', 'youtu.be', 'twitch', 'snapchat'];
    const isSocialMediaLink = (url: string) => socialMediaDomains.some(domain => url.includes(domain) || url.includes(`www.${domain}`));

    const socialLinks = combinedLinks.filter(link => link.url && isSocialMediaLink(link.url));
    const otherLinks = combinedLinks.filter(link => link.url && !isSocialMediaLink(link.url));

    const uniqueSocialLinks = Array.from(new Set(socialLinks.map(link => JSON.stringify(link)))).map(link => JSON.parse(link));
    const uniqueOtherLinks = Array.from(new Set(otherLinks.map(link => JSON.stringify(link)))).map(link => JSON.parse(link));

    return { uniqueSocialLinks, uniqueOtherLinks };
};

const extractUsernames = (uniqueSocialLinks: any[], platform: string) => {
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

const sanitizeText = (text: string | null | undefined): string => {
    if (!text) return '';
    return text.replace(/\n/g, ' ');
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

// const fetchTwitchData = async (username: string) => {
//     const headers = {
//         'Client-Id': twitchClientId || '',
//         'Authorization': `Bearer ${twitchClientSecret || ''}`
//     };

//     const profileUrl = `https://api.twitch.tv/helix/users?login=${username}`;
//     const profileResponse = await fetch(profileUrl, { method: 'GET', headers });

//     if (!profileResponse.ok) {
//         throw new Error(`Failed to fetch data for Twitch user ${username}`);
//     }

//     const data = await profileResponse.json();

//     if (!data.data || data.data.length === 0) {
//         throw new Error(`No data found for Twitch user ${username}`);
//     }

//     const broadcaster_id = data.data[0].id;

//     const followersUrl = `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcaster_id}`;
//     const [followersResponse] = await Promise.all([
//         fetch(followersUrl, { method: 'GET', headers })
//     ]);

//     if (!followersResponse.ok) {
//         throw new Error(`Failed to fetch data for Twitch user ${username}`);
//     }

//     const followersData = await followersResponse.json();
//     const followerCount = followersData.total;

//     return { login: username, bio: data.data[0].description, followerCount };
// };   

const expandYouTubeShortLink = async (shortUrl: string) => {
    const response = await fetch(shortUrl, { redirect: 'follow' });
    return response.url;
};

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log }) => {
    const { pageTitle, profileName, socialIcons, links, emailsFromContent } = await extractProfileData(page);

    const emails: Set<string> = new Set(emailsFromContent);
    const combinedLinks = combineAndFilterLinks(socialIcons, links, emails);

    const { uniqueSocialLinks } = separateLinks(combinedLinks);

    const [instagramUsernames, tiktokUsernames] = [
        extractUsernames(uniqueSocialLinks, 'instagram'),
        extractUsernames(uniqueSocialLinks, 'tiktok')
    ];

    const twitterUrls = uniqueSocialLinks.filter(link => link && link.url && (link.url.includes('x.com') || link.url.includes('twitter.com'))).map(link => link.url);
    const twitterStartUrls = twitterUrls.map(url => Array(5).fill(url)).flat();

    const youtubeUrls = uniqueSocialLinks.filter(link => link && link.url && (link.url.includes('youtube') || link.url.includes('youtu.be'))).map(link => link.url);
    const expandedYouTubeUrls = await Promise.all(youtubeUrls.map(url => url.includes('youtu.be') ? expandYouTubeShortLink(url) : url));
    const youtubeStartUrls = expandedYouTubeUrls.map(url => ({ url, method: 'GET' }));

    const snapchatStartUrls = uniqueSocialLinks.filter(link => link && link.url && link.url.includes('snapchat')).map(link => link.url);

    const [instagramResult, tiktokResult, twitterResult, youtubeResult, snapchatResult] = await Promise.all([
        instagramUsernames.length ? fetchSocialMediaData('instagram', { usernames: instagramUsernames, resultsLimit: 1 }) : [],
        tiktokUsernames.length ? fetchSocialMediaData('tiktok', { profiles: tiktokUsernames, resultsPerPage: 1 }) : [],
        twitterStartUrls.length ? fetchSocialMediaData('twitter', { startUrls: twitterStartUrls, getFollowers: false, getFollowing: false, getRetweeters: false }) : [],
        youtubeStartUrls.length ? fetchSocialMediaData('youtube', { startUrls: youtubeStartUrls, maxResults: 1, maxResultStreams: 0, maxResultsShorts: 0 }) : [],
        snapchatStartUrls.length ? fetchSocialMediaData('snapchat', { profilesInput: snapchatStartUrls }) : [],
    ]);

    const instagram = instagramResult.length && instagramResult[0] ? {
        url: instagramResult[0].url,
        username: instagramResult[0].username,
        displayName: instagramResult[0].fullName,
        followerCount: instagramResult[0].followersCount,
        bio: sanitizeText(instagramResult[0].biography as string),
        emailsFound: Array.from(extractEmails(instagramResult[0].biography as string)),
    } : null;

    const tiktok = tiktokResult.length && tiktokResult[0] ? {
        url: (tiktokResult[0] as any).authorMeta.profileUrl,
        username: (tiktokResult[0] as any).authorMeta.name,
        displayName: (tiktokResult[0] as any).authorMeta.nickName,
        followerCount: (tiktokResult[0] as any).authorMeta.fans,
        likeCount: (tiktokResult[0] as any).authorMeta.heart,
        bio: sanitizeText((tiktokResult[0] as any).authorMeta.signature),
        emailsFound: Array.from(extractEmails((tiktokResult[0] as any).authorMeta.signature as string)),
    } : null;

    console.log(twitterResult);
    
    const twitter = twitterResult && twitterResult.length && twitterResult[0] ? {
        url: twitterResult[0].url,
        username: twitterResult[0].userName,
        displayName: twitterResult[0].name,
        followerCount: twitterResult[0].followers,
        bio: sanitizeText(twitterResult[0].description as string),
        location: twitterResult[0].location,
        emailsFound: Array.from(extractEmails(twitterResult[0].description as string)),
    } : null;
    
    const snapchat = snapchatResult.length && snapchatResult[0] ? {
        url: snapchatResult[0].profileUrl,
        username: snapchatResult[0].username1,
        bio: sanitizeText(snapchatResult[0].profileDescription as string),
        emailsFound: Array.from(extractEmails(snapchatResult[0].profileDescription as string))
    } : null;
    
    const youtube = youtubeResult.length && youtubeResult[0] ? {
        url: youtubeResult[0].url,
        channelName: youtubeResult[0].channelName,
        channelId: youtubeResult[0].channelId,
        subscriberCount: youtubeResult[0].numberOfSubscribers,
        channelDescription: sanitizeText(youtubeResult[0].channelDescription as string),
        viewCount: youtubeResult[0].viewCount,
        country: youtubeResult[0].channelLocation,
        emailsFound: Array.from(extractEmails(youtubeResult[0].channelDescription as string)),
    } : null;

    const allEmails = Array.from(new Set([...emailsFromContent, ...(instagram?.emailsFound || []), ...(tiktok?.emailsFound || []), ...(twitter?.emailsFound || []), ...(snapchat?.emailsFound || []), ...(youtube?.emailsFound || [])]));
    const mainEmail = allEmails.filter(email => email)[0];

    // get the platform with highest follower count
    const platforms = [
        { name: 'Instagram', count: instagram?.followerCount || 0 },
        { name: 'TikTok', count: tiktok?.followerCount || 0 },
        { name: 'Twitter', count: twitter?.followerCount || 0 },
        { name: 'YouTube', count: youtube?.subscriberCount || 0 },
    ];

    const topPlatform = platforms.reduce(
        (max, current) => (current.count > max.count ? current : max),
        { name: '', count: 0 }
    );

    log.info(`URL: ${request.url}, TITLE: ${pageTitle}`);
    log.info(`Profile Name: ${profileName}`);
    log.info(`Final email count: ${emails.size}`);

    await Dataset.pushData({
        "01_emailfound_linktree": Array.from(emails),
        "02_insta_url": instagram ? instagram.url : null,
        "03_emailfound_insta": instagram ? instagram.emailsFound : [],
        "04_tiktok_url": tiktok ? tiktok.url : null,
        "05_emailfound_tiktok": tiktok ? tiktok.emailsFound : [],
        "06_x_url": twitter ? twitter.url : null,
        "07_emailfound_x": twitter ? twitter.emailsFound : [],
        "08_youtube_url": youtube ? youtube.url : null,
        "09_emailfound_youtube": youtube ? youtube.emailsFound : [],
        "10_snap_url": snapchat ? snapchat.url : null,
        "11_emailfound_snap": snapchat ? snapchat.emailsFound : [],
        "12_x_location": twitter ? twitter.location : null,
        "13_youtube_country": youtube ? youtube.country : null,
        "14_youtube_channelViews": youtube ? youtube.viewCount : null,
        "15_tiktok_likeCount": tiktok ? tiktok.likeCount : null,
        "16_tiktok_followerCount": tiktok ? tiktok.followerCount : null,
        "17_x_followerCount": twitter ? twitter.followerCount : null,
        "18_youtube_subscriberCount": youtube ? youtube.subscriberCount : null,
        "19_insta_followerCount": instagram ? instagram.followerCount : null,
        "20_linktree_pagetitle": pageTitle,
        "21_snap_bio": snapchat ? snapchat.bio : null,
        "22_x_bio": twitter ? twitter.bio : null,
        "23_youtube_channelDiscription": youtube ? youtube.channelDescription : null,
        "24_tiktok_bio": tiktok ? tiktok.bio : null,
        "25_insta_bio": instagram ? instagram.bio : null,
        "26_snap_username": snapchat ? snapchat.username : null,
        "27_x_username": twitter ? twitter.username : null,
        "28_x_displayname": twitter ? twitter.displayName : null,
        "29_youtube_channelName": youtube ? youtube.channelName : null,
        "30_linktree_profilename": profileName,
        "31_tiktok_username": tiktok ? tiktok.username : null,
        "32_tiktok_displayname": tiktok ? tiktok.displayName : null,
        "33_insta_username": instagram ? instagram.username : null,
        "34_insta_displayname": instagram ? instagram.displayName : null,
        "35_mainEmail": mainEmail,
        "36_mainPlatform": topPlatform,
        "37_linktree_url": request.loadedUrl,
    });
});
