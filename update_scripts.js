const fs = require('fs');
const path = require('path');
const dir = './frontend';

function updateScript(file, newScript) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return;
    let c = fs.readFileSync(p, 'utf8');
    c = c.replace(/<script>[\s\S]*?<\/script>/, `<script>\n${newScript}\n    </script>`);
    fs.writeFileSync(p, c);
}

// 1. Description Exporter
const descriptionScript = `
        const API_URL = '/extract/video-details';
        const HEALTH_URL = '/health';

        class ExtractorApp {
            constructor() {
                this.input = document.getElementById('channelInput');
                this.extractBtn = document.getElementById('extractBtn');
                this.btnText = this.extractBtn.querySelector('span');
                this.btnIcon = this.extractBtn.querySelector('.ph-arrow-right');
                this.spinner = document.getElementById('btnSpinner');
                
                this.searchContainer = document.getElementById('searchContainer');
                this.resultsContainer = document.getElementById('resultsContainer');
                this.videoGrid = document.getElementById('videoGrid');
                this.toastContainer = document.getElementById('toastContainer');
                
                this.copyAllBtn = document.getElementById('copyAllBtn');
                this.saveTxtBtn = document.getElementById('saveTxtBtn');
                this.saveJsonBtn = document.getElementById('saveJsonBtn');

                this.currentData = null;
                this.bindEvents();
            }

            bindEvents() {
                this.extractBtn.addEventListener('click', () => this.handleExtract());
                this.input.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.handleExtract(); });
                this.copyAllBtn.addEventListener('click', () => this.copyToClipboard(this.currentData.description || ''));
                this.saveTxtBtn.addEventListener('click', () => this.downloadFile(this.currentData.description || '', 'description.txt', 'text/plain'));
                this.saveJsonBtn.addEventListener('click', () => this.downloadFile(JSON.stringify(this.currentData, null, 2), 'metadata.json', 'application/json'));
            }

            setLoading(isLoading) {
                this.extractBtn.disabled = isLoading;
                if (isLoading) {
                    this.btnText.textContent = 'Extracting...';
                    this.btnIcon.style.display = 'none';
                    this.spinner.style.display = 'block';
                } else {
                    this.btnText.textContent = 'Extract';
                    this.btnIcon.style.display = 'block';
                    this.spinner.style.display = 'none';
                }
            }

            showToast(message, type = 'info') {
                const toast = document.createElement('div');
                toast.className = \`toast \${type}\`;
                toast.innerHTML = \`<i class="ph-fill \${type === 'success' ? 'ph-check-circle' : 'ph-warning-circle'}"></i><span>\${message}</span>\`;
                this.toastContainer.appendChild(toast);
                setTimeout(() => {
                    toast.style.animation = 'slideOut 0.3s ease forwards';
                    setTimeout(() => toast.remove(), 300);
                }, 3000);
            }

            async handleExtract() {
                const query = this.input.value.trim();
                if (!query) { this.showToast('Please enter a YouTube video URL', 'error'); return; }

                this.setLoading(true);
                this.resultsContainer.style.display = 'none';

                try {
                    const response = await fetch(API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: query })
                    });
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error || 'Failed to extract description');

                    this.currentData = data;
                    this.renderResults(data);
                    this.showToast('Description extracted successfully!', 'success');
                    this.searchContainer.classList.add('active');
                } catch (error) {
                    this.showToast(error.message, 'error');
                } finally {
                    this.setLoading(false);
                }
            }

            renderResults(data) {
                document.getElementById('channelNameDisplay').textContent = data.title || 'Unknown Title';
                document.getElementById('videoCountDisplay').textContent = '1';
                
                this.videoGrid.innerHTML = \`
                    <div style="background: var(--surface-color); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); width: 100%; white-space: pre-wrap; font-size: 1rem; color: var(--text-main); line-height: 1.6;">\${data.description || 'No description available for this video.'}</div>
                \`;
                this.resultsContainer.style.display = 'flex';
            }

            async copyToClipboard(text) {
                try {
                    await navigator.clipboard.writeText(text);
                    this.showToast('Copied to clipboard!', 'success');
                } catch (err) {
                    this.showToast('Failed to copy text', 'error');
                }
            }

            downloadFile(content, filename, contentType) {
                const blob = new Blob([content], { type: contentType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                this.showToast(\`Downloaded \${filename}\`, 'success');
            }
        }
        const app = new ExtractorApp();
`;

// 2. Video Tags Exporter
const tagsScript = descriptionScript
    .replace('API_URL = \'/extract/video-details\'', 'API_URL = \'/extract/video-details\'')
    .replace('this.copyToClipboard(this.currentData.description || \'\')', 'this.copyToClipboard((this.currentData.tags || []).join(\', \'))')
    .replace('this.downloadFile(this.currentData.description || \'\', \'description.txt\'', 'this.downloadFile((this.currentData.tags || []).join(\'\\n\'), \'tags.txt\'')
    .replace('Description extracted', 'Tags extracted')
    .replace('No description available', 'No tags available')
    .replace('data.description', 'data.tags && data.tags.length > 0 ? data.tags.map(t => `<span style="background: var(--primary); color: white; padding: 0.2rem 0.8rem; border-radius: 20px; font-size: 0.9rem; display: inline-block; margin: 0.2rem;">#${t}</span>`).join("") : "No tags available."')
    .replace('white-space: pre-wrap', '');

// 3. Comments Exporter
const commentsScript = descriptionScript
    .replace('API_URL = \'/extract/video-details\'', 'API_URL = \'/extract/comments\'')
    .replace('this.copyToClipboard(this.currentData.description || \'\')', 'this.copyToClipboard((this.currentData.comments || []).map(c => c.author + ": " + c.text).join(\'\\n\\n\'))')
    .replace('this.downloadFile(this.currentData.description || \'\', \'description.txt\'', 'this.downloadFile((this.currentData.comments || []).map(c => c.author + ": " + c.text).join(\'\\n\\n\'), \'comments.txt\'')
    .replace('Description extracted', 'Comments extracted')
    .replace('No description available', 'No comments available')
    .replace('document.getElementById(\'videoCountDisplay\').textContent = \'1\'', 'document.getElementById(\'videoCountDisplay\').textContent = data.commentCount || 0')
    .replace(/\`[\s\S]*?\`/m, `\`\n                    <div style="display: flex; flex-direction: column; gap: 1rem; width: 100%;">\n                        \${data.comments && data.comments.length > 0 ? data.comments.map(c => \`<div style="background: rgba(255,255,255,0.05); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border);">\n                            <strong style="color: var(--primary); display: block; margin-bottom: 0.5rem;">\${c.author}</strong>\n                            <p style="white-space: pre-wrap; font-size: 0.95rem; line-height: 1.5;">\${c.text}</p>\n                            <small style="color: var(--text-muted); display: block; margin-top: 0.8rem;">👍 \${c.likeCount || 0} &nbsp;&bull;&nbsp; \${c.timeText || \'\'}</small>\n                        </div>\`).join("") : "<p>No comments available.</p>"}\n                    </div>\n                \``);

updateScript('description-exporter.html', descriptionScript);
updateScript('tags-exporter.html', tagsScript);
updateScript('comments-exporter.html', commentsScript);

console.log('Updated frontend scripts for Description, Tags, and Comments tools.');
