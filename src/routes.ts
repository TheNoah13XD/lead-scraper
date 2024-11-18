import { Dataset, createPlaywrightRouter } from 'crawlee';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log }) => {
    const pageTitle = await page.title();
    log.info(`URL: ${request.url}, TITLE: ${pageTitle}`);

    const { profileName, pageContent, socialIcons, links } = await page.evaluate(() => {
        const nameElement = document.querySelector('#profile-title') as HTMLElement;
        const profileName = nameElement?.innerText || 'Unknown';

        const pageContent = document.body.innerText;

        const socialIcons = Array.from(document.querySelectorAll('a[data-testid="SocialIcon"]')).map(icon => ({
            title: icon.getAttribute('title') || 'Unknown',
            url: icon.getAttribute('href') || 'Unknown',
        }));

        const links = Array.from(document.querySelectorAll('a[data-testid="LinkButton"]')).map(anchor => ({
            title: anchor.querySelector('p')?.innerText || 'Unknown',
            url: anchor.getAttribute('href') || 'Unknown',
        }));

        return { profileName, pageContent, socialIcons, links };
    });

    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    let emails: Set<string> = new Set(pageContent.match(emailRegex) || []);

    const filteredSocialIcons = socialIcons.filter(icon => {
        if (emailRegex.test(icon.url)) {
            emails.add(icon.url.replace(/^mailto:/, ''));
            return false;
        }
        return true;
    });

    links.forEach(link => {
        if (emailRegex.test(link.url)) {
            emails.add(link.url.replace(/^mailto:/, ''));
        }
    });

    log.info(`Final merged emails: ${emails.size}`);
    log.info(`Found ${filteredSocialIcons.length} social icons on ${request.url}`);

    await Dataset.pushData({
        url: request.loadedUrl,
        pageTitle,
        profileName,
        emails: Array.from(emails),
        socialIcons: filteredSocialIcons,
        profileLinks: links
    });
});
