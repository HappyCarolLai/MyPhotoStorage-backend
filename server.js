// MyPhotoStorage-backend/server.js - 批次相簿管理核心 (MongoDB & Cloudflare R2 整合)
const mongoose = require('mongoose'); 
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const session = require('express-session'); // ⭐ 新增
const multer = require('multer');
const cors = require('cors'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp'); 
const heicConvert = require('heic-convert'); 

const app = express();
app.use(cors()); 
app.use(express.json()); 

// ⭐ 全域變數：追蹤所有背景處理任務
const mediaTasks = {}; 

// ============================================================
// ⭐ 新增：Session 與密碼認證設定
// ============================================================

const PHOTO_PASSWORD = process.env.PHOTO_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

// 檢查必要的認證環境變數
if (!PHOTO_PASSWORD || !SESSION_SECRET) {
    console.error("❌ 錯誤：缺少 PHOTO_PASSWORD 或 SESSION_SECRET 環境變數");
    process.exit(1);
}

// 設定 Session 中介層
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // 生產環境使用 HTTPS
        httpOnly: true, // 防止 XSS 攻擊
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天（毫秒）
        sameSite: 'lax' // 防止 CSRF 攻擊
    }
}));

// 認證中介層函數
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    
    // 如果是 API 請求，回傳 401
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: '未授權，請先登入' });
    }
    
    // 如果是頁面請求，重導向到登入頁
    res.redirect(`/login.html?redirect=${encodeURIComponent(req.path)}`);
}

// ⭐ 認證 API 路由
// [POST] 登入
app.post('/api/auth/login', (req, res) => {
    const { password, rememberMe } = req.body;
    
    if (password === PHOTO_PASSWORD) {
        req.session.authenticated = true;
        
        // 如果選擇「記住我」，延長 cookie 有效期為 30 天，否則僅此次瀏覽期間有效
        if (rememberMe) {
            req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 天
        } else {
            req.session.cookie.expires = false; // 關閉瀏覽器後失效
        }
        
        return res.json({ success: true, message: '登入成功' });
    } else {
        return res.status(401).json({ error: '密碼錯誤' });
    }
});

// [GET] 檢查登入狀態
app.get('/api/auth/check', (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.json({ authenticated: true });
    }
    return res.status(401).json({ authenticated: false });
});

// [POST] 登出
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: '登出失敗' });
        }
        res.clearCookie('connect.sid');
        return res.json({ success: true, message: '已登出' });
    });
});

// ============================================================
// ⭐ 靜態檔案服務（需套用認證，但排除登入頁面）
// ============================================================

// 允許未登入存取的路徑
const publicPaths = [
    '/login.html',
    '/style.css',
    '/images/'
];

// 靜態檔案中介層（附加認證檢查）
app.use((req, res, next) => {
    // 檢查是否為公開路徑
    const isPublicPath = publicPaths.some(path => req.path.startsWith(path));
    
    if (isPublicPath) {
        return next();
    }
    
    // 其他靜態檔案需要認證
    requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, '')));

// ============================================================
// 原有的 Multer、R2、MongoDB 設定（完全保留）
// ============================================================

const upload = multer({ 
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, os.tmpdir()); 
        },
        filename: function (req, file, cb) {
            cb(null, `${Date.now()}-${file.originalname.substring(0, 30)}`);
        }
    }),
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB
    }
}); 

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_API_ENDPOINT = process.env.R2_API_ENDPOINT;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const MONGODB_URL = process.env.MONGODB_URL; 

if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_API_ENDPOINT || !R2_PUBLIC_URL || !R2_BUCKET_NAME || !MONGODB_URL) {
    console.error("❌ 錯誤：必要的環境變數缺失 (R2 或 MongoDB)");
    process.exit(1); 
}

const s3Client = new S3Client({
    region: 'auto',
    endpoint: R2_API_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    }
});

async function deleteFileFromR2(storageFileName) {
    const params = {
        Bucket: R2_BUCKET_NAME,
        Key: `images/${storageFileName}`, 
    };
    await s3Client.send(new DeleteObjectCommand(params));
}

mongoose.connect(MONGODB_URL)
    .then(() => console.log('✅ MongoDB 連線成功'))
    .catch(err => console.error('❌ MongoDB 連線失敗:', err));

const PhotoSchema = new mongoose.Schema({
    originalFileName: { type: String, required: true }, 
    storageFileName: { type: String, required: true, unique: true }, 
    githubUrl: { type: String, required: true }, 
    albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album' }, 
    uploadedAt: { type: Date, default: Date.now } 
});

const AlbumSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, unique: true }, 
    coverUrl: { type: String, default: '' }, 
    photoCount: { type: Number, default: 0 }, 
    createdAt: { type: Date, default: Date.now } 
});

const Photo = mongoose.model('Photo', PhotoSchema);
const Album = mongoose.model('Album', AlbumSchema);

async function processMedia(file) {
    const originalPath = file.path;
    const originalMime = file.mimetype;
    const originalExt = path.extname(file.originalname).toLowerCase();
    const logName = Buffer.from(file.originalname, 'latin1').toString('utf8');

    if (
        originalMime === 'image/jpeg' || 
        originalMime === 'image/png' || 
        originalMime === 'image/webp' || 
        originalExt === '.jpg' ||
        originalExt === '.jpeg' ||
        originalExt === '.png' ||
        originalExt === '.webp' 
    ) {
        const outputExt = '.jpg';
        const outputPath = path.join(os.tmpdir(), `${path.basename(originalPath)}-optimized${outputExt}`);
        
        console.log(`🖼️ 偵測到圖片: ${logName}，開始進行尺寸與品質優化...`);

        try {
            await sharp(originalPath)
                .rotate()
                .resize({
                    width: 2000, 
                    height: 2000, 
                    fit: 'inside', 
                    withoutEnlargement: true
                })
                .jpeg({ 
                    quality: 80,
                    mozjpeg: true 
                })
                .toFile(outputPath);
            
            console.log(`✅ 圖片優化完成: ${logName}`);
            return { path: outputPath, mime: 'image/jpeg', ext: outputExt };
        } catch (err) {
            console.error('❌ Sharp 處理圖片失敗，改回原始檔案:', err.message);
            return { path: originalPath, mime: originalMime, ext: originalExt };
        }
    }
    
    else if (
        originalMime === 'image/heic' || 
        originalMime === 'image/heif' || 
        originalExt === '.heic' || 
        originalExt === '.heif'
    ) {
        const outputExt = '.jpeg';
        const outputPath = path.join(os.tmpdir(), `${path.basename(originalPath)}-converted${outputExt}`);
        console.log(`📸 偵測到 HEIC 檔案: ${logName}，開始轉換...`);
        
        try {
            const inputBuffer = fs.readFileSync(originalPath);
            const jpegBuffer = await heicConvert({
                buffer: inputBuffer,
                format: 'JPEG', 
                quality: 0.8
            });
            fs.writeFileSync(outputPath, jpegBuffer);
            
            const finalPath = outputPath + "-opt.jpg";
            await sharp(outputPath).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).toFile(finalPath);
            
            console.log('✅ HEIC 轉換與優化完成');
            return { path: finalPath, mime: 'image/jpeg', ext: '.jpg' };
        } catch (err) {
            console.error('❌ HEIC 轉換失敗:', err.message);
            throw new Error(`HEIC 轉換失敗: ${err.message}`);
        }
    }
    
    else if (originalMime.startsWith('video/') || originalExt === '.mov' || originalExt === '.mp4') {
        const outputExt = '.mp4';
        const outputPath = path.join(os.tmpdir(), `${path.basename(originalPath)}-compressed${outputExt}`);
        console.log(`🎬 偵測到影片: ${logName}，開始壓縮...`);
        
        await new Promise((resolve, reject) => {
            ffmpeg(originalPath)
                .outputOptions(['-c:v libx264', '-preset veryfast', '-crf 28', '-pix_fmt yuv420p', '-c:a aac', '-b:a 128k'])
                .on('end', () => { console.log('✅ 影片壓縮完成'); resolve(); })
                .on('error', (err) => reject(new Error(`FFmpeg 失敗: ${err.message}`)))
                .save(outputPath);
        });

        return { path: outputPath, mime: 'video/mp4', ext: outputExt };
    }
    
    throw new Error(`不支援的檔案類型: ${originalMime}`);
}

async function processMediaInBackground(taskId) {
    const task = mediaTasks[taskId];
    if (!task) return; 

    const { file, targetAlbum } = task;
    const originalnameFixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const baseName = originalnameFixed.replace(/[^a-z0-9\u4e00-\u9fa5\.\-]/gi, '_');

    task.status = 'PROCESSING';
    task.message = `開始處理檔案: ${originalnameFixed}`;
    console.log(`[TASK ${taskId}] 開始處理: ${originalnameFixed}`);

    const filesToCleanup = [file.path]; 
    let processedMedia; 

    try {
        processedMedia = await processMedia(file); 
        
        task.message = '媒體處理完成，開始上傳 R2 雲端儲存...';
        console.log(`[TASK ${taskId}] 媒體處理完成，開始上傳 R2...`);

        if (processedMedia.path !== file.path) {
            filesToCleanup.push(processedMedia.path);
        }

        const cleanName = baseName
            .replace(/-optimized/g, '')
            .replace(/-converted/g, '')
            .replace(/-compressed/g, '');

        const rawFileName = `${Date.now()}-${cleanName.replace(path.extname(cleanName), processedMedia.ext)}`; 
        const fileKey = `images/${rawFileName}`; 

        const fileStream = fs.createReadStream(processedMedia.path);
        
        const uploadParams = {
            Bucket: R2_BUCKET_NAME,
            Key: fileKey,
            Body: fileStream, 
            ContentType: processedMedia.mime, 
            ACL: 'public-read', 
            CacheControl: 'public, max-age=31536000, immutable' 
        };
        
        await s3Client.send(new PutObjectCommand(uploadParams));
        
        const r2PublicUrl = `${R2_PUBLIC_URL}/${fileKey}`; 
        
        task.message = 'R2 上傳完成，寫入資料庫...';
        console.log(`[TASK ${taskId}] R2 上傳完成，寫入資料庫...`);

        const newPhoto = new Photo({
            originalFileName: originalnameFixed,
            storageFileName: rawFileName,
            githubUrl: r2PublicUrl, 
            albumId: targetAlbum._id
        });
        await newPhoto.save();
        
        await Album.findByIdAndUpdate(targetAlbum._id, { $inc: { photoCount: 1 } });
        
        task.status = 'COMPLETED';
        task.message = `✅ 處理成功！耗時: ${((Date.now() - task.startTime) / 1000).toFixed(1)} 秒`;
        task.resultUrl = r2PublicUrl;
        console.log(`[TASK ${taskId}] 完成: ${originalnameFixed}`);

    } catch (error) {
        const errorMessage = error.message;
        task.status = 'FAILED';
        task.message = `❌ 處理失敗: ${errorMessage}`;
        console.error(`[TASK ${taskId}] 處理失敗: ${originalnameFixed} 錯誤:`, errorMessage);
    } finally {
        for (const p of filesToCleanup) {
             try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                }
            } catch (cleanupError) {
                console.error(`[TASK ${taskId}] 刪除暫存檔 ${p} 失敗:`, cleanupError.message);
            }
        }
        setTimeout(() => delete mediaTasks[taskId], 600000);
    }
}

// ============================================================
// ⭐ API 路由 - 所有需要認證（除了 /api/auth/* 之外）
// ============================================================

app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        message: 'MyPhotoStorage Backend Service is running and ready for API requests.'
    });
});

// ⭐ 以下所有 API 路由都需要認證
app.get('/api/albums', requireAuth, async (req, res) => {
    try {
        let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
        if (!defaultAlbum) {
            defaultAlbum = new Album({ name: '未分類相簿' });
            await defaultAlbum.save();
        }

        const albums = await Album.find().sort({ createdAt: -1 });
        res.json(albums);
    } catch (error) {
        console.error('取得相簿列表失敗:', error);
        res.status(500).json({ error: '無法取得相簿列表' });
    }
});

app.post('/api/albums', requireAuth, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ error: '相簿名稱不能為空' });
        }
        
        const existingAlbum = await Album.findOne({ name });
        if (existingAlbum) {
             return res.status(409).json({ error: '相簿名稱已存在' });
        }
        
        const newAlbum = new Album({ name });
        await newAlbum.save();
        res.status(201).json(newAlbum);
    } catch (error) {
        console.error('新增相簿失敗:', error);
        res.status(500).json({ error: '無法新增相簿' });
    }
});

app.put('/api/albums/:id', requireAuth, async (req, res) => {
    try {
        const { name, coverUrl } = req.body;
        if (!name) {
            return res.status(400).json({ error: '相簿名稱不能為空' });
        }
        
        if (name === '未分類相簿') {
            return res.status(403).json({ error: '禁止將相簿名稱設定為「未分類相簿」' });
        }

        const album = await Album.findByIdAndUpdate(
            req.params.id, 
            { name: name, coverUrl: coverUrl }, 
            { new: true, runValidators: true } 
        );

        if (!album) {
            return res.status(404).json({ error: '找不到該相簿' });
        }

        res.json(album);
    } catch (error) {
        console.error('更新相簿失敗:', error);
        res.status(500).json({ error: '無法更新相簿' });
    }
});

app.delete('/api/albums/:id', requireAuth, async (req, res) => {
    try {
        const albumId = req.params.id;
        
        const albumToDelete = await Album.findById(albumId);
        if (!albumToDelete) {
            return res.status(404).json({ error: '找不到該相簿' });
        }
        
        if (albumToDelete.name === '未分類相簿') {
            return res.status(403).json({ error: '禁止刪除預設的「未分類相簿」' });
        }

        let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
        if (!defaultAlbum) {
            return res.status(500).json({ error: '系統錯誤：找不到預設相簿' });
        }

        const updateResult = await Photo.updateMany(
            { albumId: albumId }, 
            { $set: { albumId: defaultAlbum._id } } 
        );
        
        if (updateResult.modifiedCount > 0) {
            await Album.findByIdAndUpdate(defaultAlbum._id, { $inc: { photoCount: updateResult.modifiedCount } });
        }

        await Album.findByIdAndDelete(albumId);

        res.json({ 
            message: `相簿「${albumToDelete.name}」已刪除，其中 ${updateResult.modifiedCount} 張照片已移至「未分類相簿」。`
        });
        
    } catch (error) {
        console.error('刪除相簿失敗:', error);
        res.status(500).json({ error: '無法刪除相簿' });
    }
});

app.get('/api/albums/:id/photos', requireAuth, async (req, res) => {
    try {
        const albumId = req.params.id;
        if (!(await Album.findById(albumId))) {
             return res.status(404).json({ error: '找不到該相簿' });
        }
        const photos = await Photo.find({ albumId: albumId }).sort({ uploadedAt: -1 });
        res.json(photos);
    } catch (error) {
        console.error('取得相簿照片失敗:', error);
        res.status(500).json({ error: '無法取得相簿照片' });
    }
});

app.put('/api/photos/:id', requireAuth, async (req, res) => {
    try {
        const { originalFileName } = req.body;
        if (!originalFileName) {
            return res.status(400).json({ error: '照片名稱不能為空' });
        }

        const photo = await Photo.findByIdAndUpdate(
            req.params.id, 
            { originalFileName: originalFileName }, 
            { new: true, runValidators: true }
        );

        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }

        res.json(photo);
    } catch (error) {
        console.error('更新照片名稱失敗:', error);
        res.status(500).json({ error: '無法更新照片名稱' });
    }
});

app.patch('/api/photos/:id/move', requireAuth, async (req, res) => {
    try {
        const { targetAlbumId } = req.body;
        const photoId = req.params.id;

        if (!targetAlbumId) {
            return res.status(400).json({ error: '請提供目標相簿 ID' });
        }
        
        const targetAlbum = await Album.findById(targetAlbumId);
        if (!targetAlbum) {
            return res.status(404).json({ error: '找不到目標相簿' });
        }
        
        const photo = await Photo.findById(photoId);
        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }
        
        const oldAlbumId = photo.albumId; 
        
        if (oldAlbumId && oldAlbumId.toString() === targetAlbumId) {
            return res.status(200).json({ message: '照片已在目標相簿中', photo: photo });
        }

        photo.albumId = targetAlbumId;
        await photo.save();

        await Album.findByIdAndUpdate(oldAlbumId, { $inc: { photoCount: -1 } }); 
        await Album.findByIdAndUpdate(targetAlbumId, { $inc: { photoCount: 1 } }); 

        res.json({ message: '照片已成功移動', photo: photo });

    } catch (error) {
        console.error('移動照片失敗:', error);
        res.status(500).json({ error: '無法移動照片' });
    }
});

app.delete('/api/photos/:id', requireAuth, async (req, res) => {
    try {
        const photo = await Photo.findById(req.params.id);
        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }
        
        await deleteFileFromR2(photo.storageFileName); 
        await Photo.findByIdAndDelete(req.params.id);
        
        if (photo.albumId) {
            await Album.findByIdAndUpdate(photo.albumId, { $inc: { photoCount: -1 } });
        }

        res.json({ message: '照片已成功刪除' });

    } catch (error) {
        const errorMessage = error.message; 
        console.error('刪除照片失敗:', errorMessage);
        res.status(500).json({ error: `無法刪除照片。錯誤訊息：${errorMessage}` });
    }
});

app.post('/api/photos/bulkDelete', requireAuth, async (req, res) => {
    const { photoIds } = req.body;
    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
        return res.status(400).json({ error: '請提供有效的照片 ID 列表進行批量刪除。' });
    }

    const successes = [];
    const failures = [];
    
    const photos = await Photo.find({ _id: { $in: photoIds } }).exec();
    
    for (const photo of photos) {
        try {
            await deleteFileFromR2(photo.storageFileName); 
            await Photo.deleteOne({ _id: photo._id });
            
            if (photo.albumId) {
                await Album.findByIdAndUpdate(photo.albumId, { $inc: { photoCount: -1 } });
            }

            successes.push(photo._id);
        } catch (error) {
            const errorMessage = error.message; 
            console.error(`刪除照片 ${photo._id} 失敗:`, errorMessage);
            
            failures.push({ 
                _id: photo._id, 
                error: `R2 刪除失敗: ${errorMessage}` 
            });
        }
    }

    if (successes.length === 0 && failures.length > 0) {
        return res.status(500).json({
            error: `批量刪除請求失敗。成功 ${successes.length} 張，失敗 ${failures.length} 張。`,
            failures
        });
    }

    res.status(200).json({
        message: `批量刪除完成。成功刪除 ${successes.length} 張，失敗 ${failures.length} 張。`,
        successes,
        failures
    });
});

app.post('/api/photos/bulkMove', requireAuth, async (req, res) => {
    const { photoIds, targetAlbumId } = req.body;

    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0 || !targetAlbumId) {
        return res.status(400).json({ error: '請提供有效的照片 ID 列表和目標相簿 ID。' });
    }

    const targetAlbum = await Album.findById(targetAlbumId);
    if (!targetAlbum) {
        return res.status(404).json({ error: '找不到目標相簿。' });
    }

    const successes = [];
    const failures = [];
    
    try {
        const photos = await Photo.find({ _id: { $in: photoIds } }).select('albumId');
        if (photos.length === 0) {
            return res.status(404).json({ error: '找不到任何指定的照片。' });
        }
        
        const oldAlbumUpdates = new Map();
        photos.forEach(photo => {
            const oldId = photo.albumId ? photo.albumId.toString() : 'null'; 
            
            if (oldId !== targetAlbumId.toString()) { 
                 oldAlbumUpdates.set(oldId, (oldAlbumUpdates.get(oldId) || 0) + 1);
            }
        });

        const updateResult = await Photo.updateMany(
            { _id: { $in: photoIds }, albumId: { $ne: targetAlbumId } }, 
            { $set: { albumId: targetAlbumId } }
        );
        
        const actualMovedCount = updateResult.modifiedCount;

        if (updateResult.acknowledged) {
            const decrementPromises = [];
            for (const [oldAlbumId, count] of oldAlbumUpdates.entries()) {
                if (oldAlbumId !== targetAlbumId.toString()) { 
                     decrementPromises.push(
                        Album.findByIdAndUpdate(oldAlbumId, { $inc: { photoCount: -count } })
                    );
                }
            }
            await Promise.allSettled(decrementPromises);

            if (actualMovedCount > 0) {
                 await Album.findByIdAndUpdate(targetAlbumId, { $inc: { photoCount: actualMovedCount } });
            }
            
            photos.forEach(p => successes.push(p._id));
            
        } else {
            photoIds.forEach(id => failures.push({ _id: id, error: '資料庫更新失敗' }));
        }

    } catch (error) {
        console.error('批量移動照片失敗:', error);
        photoIds.forEach(id => failures.push({ _id: id, error: error.message }));
    }

    res.status(200).json({
        message: `批量移動完成。成功移動 ${successes.length} 張到「${targetAlbum.name}」。`,
        successes,
        failures
    });
});

app.get('/api/tasks/status/:taskId', requireAuth, (req, res) => {
    const taskId = req.params.taskId;
    const task = mediaTasks[taskId];

    if (!task) {
        return res.status(404).json({ error: '找不到該任務ID，可能已過期或完成。' });
    }
    
    const { status, message, resultUrl, originalFileName } = task;
    res.json({ status, message, resultUrl, originalFileName });
});

app.post('/api/tasks/submit-upload', requireAuth, upload.array('photos'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '沒有收到照片檔案' });
    }

    const { targetAlbumId } = req.body; 

    let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
    if (!defaultAlbum) {
        defaultAlbum = new Album({ name: '未分類相簿' });
        await defaultAlbum.save();
    }
    let targetAlbum = defaultAlbum; 
    if (targetAlbumId) {
        const foundAlbum = await Album.findById(targetAlbumId);
        if (foundAlbum) {
            targetAlbum = foundAlbum; 
        }
    }
    
    const taskIds = [];
    
    for (const file of req.files) {
        const originalnameFixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const taskId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`; 

        mediaTasks[taskId] = {
            status: 'PENDING',
            message: '等待伺服器資源進行媒體處理...',
            originalFileName: originalnameFixed, 
            targetAlbum: targetAlbum,
            file: file,
            startTime: Date.now()
        };
        taskIds.push(taskId);
        processMediaInBackground(taskId); 
    }

    return res.json({ 
        message: '檔案已提交，正在背景處理中。',
        taskIds: taskIds
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`後端伺服器已在 Port ${PORT} 啟動`);
});