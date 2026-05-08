import React, { useState, useEffect, useRef } from 'react';
import { 
  FileText, 
  Search, 
  Printer, 
  CheckCircle, 
  Users, 
  Upload, 
  X, 
  Download,
  AlertCircle,
  Loader2,
  Building2,
  Eye,
  LogIn,
  LogOut,
  UserCheck,
  UserPlus,
  ShieldCheck,
  Clock,
  Lock,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import * as pdfjs from 'pdfjs-dist';
import { extractPagesFromPDF, PDFPage } from './utils/pdfExtractor';
import { findDriverInText, DriverData } from './services/geminiService';
import { 
  auth, 
  db, 
  signInWithGoogle, 
  testFirestoreConnection, 
  handleFirestoreError, 
  OperationType 
} from './lib/firebase';
import { onAuthStateChanged, User as FirebaseUser, signOut } from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  onSnapshot, 
  collection, 
  query, 
  orderBy, 
  addDoc, 
  serverTimestamp,
  updateDoc,
  deleteDoc,
  Timestamp,
  getDocFromServer
} from 'firebase/firestore';

// --- Types ---
interface RecipientRecord {
  id: string;
  fullName: string;
  idNumber: string;
  idType: string;
  receivedAt: any;
  createdBy: string;
  createdByEmail: string;
  createdByName?: string;
}

interface AppUser {
  uid: string;
  email: string;
  fullName: string;
  role: 'admin' | 'user';
  status: 'pending' | 'approved';
  createdAt: any;
}

interface AppearanceConfig {
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string;
  appName: string;
}

enum Tab {
  EXTRACT = 'extract',
  LOG = 'log',
  USERS = 'users',
  SETTINGS = 'settings'
}

// --- Constants ---
const ADMIN_EMAILS = [
  'ahmad.abduljalil.sy@gmail.com',
  'ahmad.abduljalilmunawwara@gmail.com'
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>(Tab.EXTRACT);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userData, setUserData] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  
  const [pdfPages, setPdfPages] = useState<PDFPage[] | null>(null);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [lastUploadedBy, setLastUploadedBy] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState(0);
  const [extractStatus, setExtractStatus] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchStage, setSearchStage] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<DriverData | null>(null);
  const [editedResult, setEditedResult] = useState<DriverData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [userRecordToDelete, setUserRecordToDelete] = useState<AppUser | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<RecipientRecord | null>(null);
  const [recipients, setRecipients] = useState<RecipientRecord[]>([]);
  const [allUsers, setAllUsers] = useState<AppUser[]>([]);
  const [printingPage, setPrintingPage] = useState(false);
  const [appearance, setAppearance] = useState<AppearanceConfig>({
    primaryColor: '#2D2A70',
    secondaryColor: '#E37D2A',
    logoUrl: '',
    appName: 'شركة درة المنورة'
  });
  
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Auth Listener
  useEffect(() => {
    // Test connection on boot
    testFirestoreConnection();

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          // Fetch or create user record in Firestore
          const userDocRef = doc(db, 'users', firebaseUser.uid);
          
          // Use getDocFromServer for the initial user fetch to ensure freshness and reliability
          let userDoc;
          try {
            userDoc = await getDocFromServer(userDocRef);
          } catch (e) {
            // Fallback to regular getDoc if server-get fails (could be transient)
            userDoc = await getDoc(userDocRef);
          }
          
          if (userDoc.exists()) {
            const currentData = userDoc.data() as AppUser;
            const userEmail = firebaseUser.email?.toLowerCase() || '';
            const isTargetAdmin = ADMIN_EMAILS.some(e => e.toLowerCase() === userEmail);
            
            // Auto-promote if in the list but not admin
            if (isTargetAdmin && currentData.role !== 'admin') {
              const updatedData = { ...currentData, role: 'admin' as const, status: 'approved' as const };
              await setDoc(userDocRef, updatedData, { merge: true });
              setUserData(updatedData);
            } else {
              setUserData(currentData);
            }
          } else {
            // New User
            const userEmail = firebaseUser.email?.toLowerCase() || '';
            const isDefaultAdmin = ADMIN_EMAILS.some(e => e.toLowerCase() === userEmail);
            const newUserData: AppUser = {
              uid: firebaseUser.uid,
              email: firebaseUser.email || '',
              fullName: firebaseUser.displayName || 'Unnamed User',
              role: isDefaultAdmin ? 'admin' : 'user',
              status: isDefaultAdmin ? 'approved' : 'pending',
              createdAt: serverTimestamp()
            };
            await setDoc(userDocRef, newUserData);
            setUserData(newUserData);
          }
        } catch (err) {
          console.error("Auth initialization error:", err);
          handleFirestoreError(err, OperationType.GET, `users/${firebaseUser.uid}`);
        }
      } else {
        setUserData(null);
      }
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Recipients Sync
  useEffect(() => {
    if (!userData || userData.status !== 'approved') return;
    
    const recipientsRef = collection(db, 'recipients');
    const q = query(recipientsRef, orderBy('receivedAt', 'desc'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const records = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as RecipientRecord[];
      setRecipients(records);
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'recipients');
    });
    
    return () => unsubscribe();
  }, [userData]);

  // All Users Sync (Admin only)
  useEffect(() => {
    if (!userData || userData.role !== 'admin') return;
    
    const usersRef = collection(db, 'users');
    const unsubscribe = onSnapshot(usersRef, (snapshot) => {
      const usersList = snapshot.docs.map(doc => doc.data() as AppUser);
      setAllUsers(usersList);
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'users');
    });
    
    return () => unsubscribe();
  }, [userData]);

  // Global PDF Data Sync
  useEffect(() => {
    if (!userData || userData.status !== 'approved') return;

    const pdfDataRef = doc(db, 'config', 'pdf_data');
    const unsubscribe = onSnapshot(pdfDataRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setPdfPages(data.pages || null);
        setFileName(data.fileName || null);
        setLastUploadedBy(data.uploadedByEmail || null);
      }
    }, (err) => {
      console.warn("Global PDF data sync restriction:", err);
    });

    return () => unsubscribe();
  }, [userData]);

  // Appearance Sync
  useEffect(() => {
    const configRef = doc(db, 'config', 'appearance');
    const unsubscribe = onSnapshot(configRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as AppearanceConfig;
        setAppearance(data);
        
        // Inject CSS Variables
        const root = document.documentElement;
        if (data.primaryColor) root.style.setProperty('--color-brand-navy', data.primaryColor);
        if (data.secondaryColor) root.style.setProperty('--color-brand-gold', data.secondaryColor);
      }
    }, (err) => {
      // Appearance is allowed public read, but if it fails we just log it
      console.warn("Appearance config not loaded or restricted:", err);
    });
    return () => unsubscribe();
  }, []);

  // Handle PDF Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsExtracting(true);
    setExtractProgress(0);
    setExtractStatus('جاري تحميل الملف للمتصفح...');
    setError(null);
    setFileName(file.name);
    setOriginalFile(file);
    
    try {
      const pages = await extractPagesFromPDF(file, (p) => {
        setExtractProgress(p);
        if (p < 30) setExtractStatus('تفكيك بنية صفحات PDF...');
        else if (p < 60) setExtractStatus('تحليل المحتوى النصي والجداول...');
        else if (p < 90) setExtractStatus('تحسين جودة البيانات المستخرجة...');
        else setExtractStatus('جارِ الانتهاء من المعالجة...');
      });
      
      // Save to Firestore so everyone can see it
      const pdfDataRef = doc(db, 'config', 'pdf_data');
      await setDoc(pdfDataRef, {
        pages,
        fileName: file.name,
        uploadedAt: serverTimestamp(),
        uploadedBy: user?.uid,
        uploadedByEmail: user?.email
      });

      setPdfPages(pages);
      setExtractStatus('اكتملت المعالجة والمزامنة بنجاح!');
    } catch (err) {
      console.error(err);
      setError('فشل استخراج النص من الملف. تأكد أن الملف بصيغة PDF صحيحة.');
    } finally {
      setTimeout(() => setIsExtracting(false), 800);
    }
  };

  // Handle Search
  const handleSearch = async () => {
    if (!pdfPages) {
      setError('الرجاء رفع ملف PDF أولاً.');
      return;
    }
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setSearchStage('تهيئة محرك البحث الذكي...');
    setError(null);
    setSuccess(null);
    setSearchResult(null);

    try {
      // Simulate phases for "Premium" feel and visual feedback
      setTimeout(() => setSearchStage('تحليل الكشوفات والبيانات...'), 800);
      setTimeout(() => setSearchStage('مطابقة الهوية الرقمية...'), 1600);
      
      const result = await findDriverInText(searchQuery, pdfPages);
      
      if (result.found) {
        setSearchStage('تم التحقق من البيانات بنجاح!');
        setTimeout(() => {
          setSearchResult(result);
          setEditedResult(result);
        }, 400);
      } else {
        setError('عذراً، هذا الرقم غير مدرج في كشوفات شركة درة المنورة');
      }
    } catch (err) {
      console.error(err);
      setError('حدث خطأ أثناء البحث. حاول مرة أخرى.');
    } finally {
      setTimeout(() => {
        setIsSearching(false);
        setSearchStage(null);
      }, 2000);
    }
  };

  // Handle Print Specific Page
  const printOriginalPage = async () => {
    if (!originalFile || !searchResult?.pageNumber) return;

    setPrintingPage(true);
    try {
      const arrayBuffer = await originalFile.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
      const page = await pdf.getPage(searchResult.pageNumber);
      
      const viewport = page.getViewport({ scale: 2.5 }); // High quality
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      
      if (!context) throw new Error("Canvas context fails");
      
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({
        canvasContext: context,
        viewport: viewport,
        // @ts-ignore
        canvas: canvas
      }).promise;

      // Create a print window
      const dataUrl = canvas.toDataURL('image/png');
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(`
          <html>
            <head>
              <title>طباعة بطاقة السائق - درة المنورة</title>
              <style>
                body { margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; background: white; }
                img { max-width: 100%; max-height: 100%; object-fit: contain; }
                @page { margin: 0; size: auto; }
              </style>
            </head>
            <body>
              <img src="${dataUrl}" onload="window.print(); window.close();" />
            </body>
          </html>
        `);
        printWindow.document.close();
      }
    } catch (err) {
      console.error("Printing error:", err);
      setError("حدث خطأ أثناء محاولة طباعة الصفحة الأصلية.");
    } finally {
      setPrintingPage(false);
    }
  };

  // Handle Confirm Receipt
  const confirmDelivery = async () => {
    if (!editedResult || !user) return;

    try {
      const driverName = editedResult.fullName;
      await addDoc(collection(db, 'recipients'), {
        fullName: driverName,
        idNumber: editedResult.idNumber,
        idType: editedResult.idType,
        receivedAt: serverTimestamp(),
        createdBy: user.uid,
        createdByEmail: user.email,
        createdByName: userData?.fullName || user.displayName || user.email
      });
      
      setSearchResult(null);
      setEditedResult(null);
      setSearchQuery('');
      setSuccess(`تم تسجيل استلام السائق ${driverName} بنجاح وترحيل بياناته للسجل.`);
      setTimeout(() => setSuccess(null), 6000);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'recipients');
      setError("فشل في حفظ السجل في قاعدة البيانات.");
    }
  };

  // User Management Actions
  const approveUser = async (uid: string) => {
    try {
      await updateDoc(doc(db, 'users', uid), { status: 'approved' });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
    }
  };

  const deleteMyRequest = async () => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid));
      signOut(auth);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}`);
      setError("حدث خطأ أثناء حذف الطلب.");
    }
  };

  const formatDate = (ts: any) => {
    if (!ts) return '-';
    const date = ts instanceof Timestamp ? ts.toDate() : new Date(ts);
    return date.toLocaleString('ar-SA');
  };

  // Export to Excel
  const exportToExcel = () => {
    const worksheet = XLSX.utils.json_to_sheet(recipients.map(r => ({
      'الاسم الكامل': r.fullName,
      'رقم الهوية': r.idNumber,
      'نوع الرقم': r.idType,
      'وقت الاستلام': formatDate(r.receivedAt),
      'الموظف': r.createdByName || r.createdByEmail
    })));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "السجل");
    XLSX.writeFile(workbook, `سجل_المستلمين_${new Date().toLocaleDateString()}.xlsx`);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-navy">
        <Loader2 className="w-12 h-12 text-white animate-spin" />
      </div>
    );
  }

  const handleLogin = async () => {
    if (loggingIn) return;
    setLoggingIn(true);
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      console.error("Login error detail:", err);
      if (err.code === 'auth/popup-closed-by-user') {
        setAuthError('تم إغلاق نافذة الدخول قبل إتمام العملية. يرجى محاولة فتحها مرة أخرى وعدم إغلاقها حتى انتهاء تسجيل الدخول.');
      } else if (err.code === 'auth/popup-blocked') {
        setAuthError('يبدو أن متصفحك يمنع النوافذ المنبثقة. يرجى السماح بالنوافذ المنبثقة لهذا الموقع للمتابعة.');
      } else if (err.code === 'auth/cancelled-by-user') {
        setAuthError('تم إلغاء عملية تسجيل الدخول من قبل المستخدم.');
      } else if (err.code === 'auth/internal-error') {
        setAuthError('حدث خطأ داخلي في نظام Google. يرجى المحاولة مرة أخرى بعد قليل.');
      } else {
        setAuthError('فشل تسجيل الدخول. تأكد من اتصالك بالإنترنت وحاول مرة أخرى. (رمز الخطأ: ' + (err.code || 'unknown') + ')');
      }
    } finally {
      setLoggingIn(false);
    }
  };

  // --- Auth Pages ---
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-navy p-4 font-sans relative overflow-hidden">
        {/* Animated Background Elements */}
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-brand-gold/5 rounded-full blur-[120px] -translate-y-1/2 translate-x-1/4"></div>
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-brand-gold/10 rounded-full blur-[100px] translate-y-1/2 -translate-x-1/4"></div>
        
        <motion.div 
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="bg-white rounded-[3rem] shadow-[0_50px_100px_-20px_rgba(0,0,0,0.5)] max-w-lg w-full border-b-[12px] border-brand-gold relative overflow-hidden"
        >
          {/* Top Decorative bar */}
          <div className="absolute top-0 left-0 right-0 h-2 bg-brand-gold/20 flex gap-1">
             {[...Array(20)].map((_, i) => <div key={i} className="flex-1 h-full bg-brand-gold/40"></div>)}
          </div>

          <div className="p-12 md:p-16 text-center">
            <div className="relative inline-block mb-10">
              <div className="w-28 h-28 bg-brand-navy rounded-[2.5rem] flex items-center justify-center mx-auto shadow-2xl relative z-10 p-5 group overflow-hidden">
                <div className="absolute inset-0 bg-brand-gold/20 translate-y-full group-hover:translate-y-0 transition-transform duration-500"></div>
                {appearance.logoUrl ? (
                  <img src={appearance.logoUrl} alt="Logo" className="max-w-full max-h-full object-contain relative z-20" referrerPolicy="no-referrer" />
                ) : (
                  <Building2 className="w-12 h-12 text-white relative z-20" />
                )}
              </div>
              <div className="absolute -bottom-2 -right-2 w-10 h-10 bg-brand-gold rounded-2xl flex items-center justify-center shadow-xl z-20 border-4 border-white">
                <Lock className="w-4 h-4 text-brand-navy" />
              </div>
            </div>

            <h1 className="text-3xl font-black text-brand-navy mb-3 tracking-tight">{appearance.appName}</h1>
            <p className="text-gray-400 font-bold mb-10 text-[10px] uppercase tracking-[0.3em]">Secure Employee Portal | v2.5.0</p>
            
            <div className="space-y-6">
              <div className="bg-brand-gray/50 p-6 rounded-3xl border border-brand-navy/5 text-right">
                <p className="text-[11px] text-brand-navy/60 font-bold leading-relaxed">
                  مرحباً بك في المنصة الرقمية الموحدة لشركة درة المنورة. يرجى استخدام بريدك الإلكتروني المعتمد للدخول إلى النظام والبدء في إدارة الكشوفات.
                </p>
              </div>

              {authError && (
                <motion.div 
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="p-5 bg-red-50 border-2 border-red-100 rounded-2xl text-red-600 text-xs font-black flex items-center gap-3 text-right"
                >
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <span>{authError}</span>
                </motion.div>
              )}

              <button 
                onClick={handleLogin}
                disabled={loggingIn || authLoading}
                className="w-full relative group"
              >
                <div className="absolute -inset-0.5 bg-brand-gold rounded-2xl blur opacity-30 group-hover:opacity-60 transition duration-500"></div>
                <div className="relative w-full flex items-center justify-center gap-4 bg-brand-navy text-white px-8 py-5 rounded-2xl font-black text-lg hover:bg-brand-navy/95 transition-all active:scale-95 shadow-2xl border border-white/10 overflow-hidden">
                   {loggingIn ? (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                    >
                      <Loader2 className="w-6 h-6 text-brand-gold" />
                    </motion.div>
                  ) : (
                    <div className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center shrink-0">
                      <LogIn className="w-5 h-5 text-brand-gold transition-transform group-hover:translate-x-1" />
                    </div>
                  )}
                  <span className="flex-1 text-center pr-2">
                    {loggingIn ? 'جاري التحقق...' : 'الدخول عبر خدمة Google'}
                  </span>
                </div>
              </button>

              {authError && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="pt-2"
                >
                  <p className="text-[11px] text-gray-400 font-bold">
                    هل تواجه مشكلة في تسجيل الدخول؟ جرب <a href={window.location.href} target="_blank" rel="noopener noreferrer" className="text-brand-gold underline hover:text-brand-gold/80 transition-colors">فتح المنصة في نافذة جديدة</a> لتجاوز قيود المتصفح.
                  </p>
                </motion.div>
              )}

              <div className="flex items-center justify-center gap-2 pt-6">
                 <ShieldCheck className="w-4 h-4 text-emerald-500" />
                 <span className="text-[9px] text-gray-400 font-bold uppercase tracking-widest">End-to-End Encrypted Authentication</span>
              </div>
            </div>
          </div>
        </motion.div>
        
        {/* Version info footer */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 opacity-30">
           <div className="h-px w-8 bg-white"></div>
           <span className="text-[10px] text-white font-mono tracking-tighter">POWERED BY GEMINI ENGINE v1.5</span>
           <div className="h-px w-8 bg-white"></div>
        </div>
      </div>
    );
  }

  if (userData?.status === 'pending') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-navy p-4 font-sans relative overflow-hidden">
        {/* Background Decorative Elements */}
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-brand-gold/10 rounded-full blur-[120px] -translate-y-1/2 translate-x-1/4"></div>
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-brand-blue/10 rounded-full blur-[100px] translate-y-1/2 -translate-x-1/4"></div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="bg-white rounded-[3rem] shadow-2xl max-w-2xl w-full border-8 border-brand-navy shadow-brand-navy/40 overflow-hidden relative"
        >
          {/* Header Accent */}
          <div className="h-3 bg-brand-gold w-full absolute top-0 left-0"></div>

          <div className="p-12 md:p-16 text-center">
            <div className="w-24 h-24 bg-brand-navy/5 rounded-[2rem] flex items-center justify-center mx-auto mb-10 shadow-inner relative group">
              <div className="absolute inset-0 bg-brand-gold/20 rounded-[2rem] blur-xl opacity-0 group-hover:opacity-100 transition-all duration-700 scale-150"></div>
              <Clock className="w-12 h-12 text-brand-navy relative z-10 animate-[bounce_3s_infinite]" />
              <div className="absolute -top-2 -right-2 w-8 h-8 bg-brand-gold rounded-xl flex items-center justify-center shadow-lg transform rotate-12">
                <Lock className="w-4 h-4 text-brand-navy" />
              </div>
            </div>

            <h1 className="text-4xl font-black text-brand-navy mb-4 tracking-tight">طلبك قيد المراجعة الآن</h1>
            <p className="text-gray-400 font-bold mb-10 text-lg uppercase tracking-widest">Awaiting Identity Verification</p>
            
            <div className="bg-brand-gray/50 rounded-[2.5rem] p-8 md:p-10 border-2 border-dashed border-brand-navy/10 mb-10 relative">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-brand-navy px-6 py-2 rounded-full text-white text-[10px] font-black uppercase tracking-[0.3em]">
                System Message
              </div>
              <p className="text-2xl font-black text-brand-navy leading-relaxed italic">
                " تم إرسال طلبك بنجاح. يرجى التنسيق مع مدير التشغيل <span className="text-brand-gold">الأستاذ عبد الحميد سالمة</span> لاتخاذ الإجراء اللازم وتفعيل حسابك. "
              </p>
            </div>

            <div className="space-y-8">
              <div className="flex items-center justify-center gap-3 text-brand-navy/50 font-bold">
                <ShieldCheck className="w-5 h-5 text-emerald-500" />
                <span className="text-sm">سيقوم فريق الأمان بمراجعة بياناتك لضمان حماية النظام</span>
              </div>
              
              <div className="w-full h-px bg-brand-navy/5"></div>

              <div className="flex flex-col gap-4">
                <button 
                  onClick={() => signOut(auth)}
                  className="group flex items-center justify-center gap-3 bg-gray-50 text-gray-500 px-10 py-5 rounded-2xl font-black text-lg hover:bg-brand-navy hover:text-white transition-all active:scale-95 border border-transparent shadow-sm"
                >
                  <LogOut className="w-5 h-5 transition-transform group-hover:-translate-x-1" />
                  تسجيل الخروج من النظام
                </button>

                {!showDeleteConfirm ? (
                  <button 
                    onClick={() => setShowDeleteConfirm(true)}
                    className="text-red-400 hover:text-red-600 transition-colors font-bold text-sm flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    حذف طلب التسجيل بالكامل
                  </button>
                ) : (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-red-50 p-6 rounded-3xl border-2 border-red-100 space-y-4"
                  >
                    <p className="text-red-800 font-black text-sm">هل أنت متأكد؟ سيتم حذف كافة بياناتك المسجلة وسيتعين عليك التسجيل من جديد عند العودة.</p>
                    <div className="flex items-center justify-center gap-4">
                      <button 
                        onClick={deleteMyRequest}
                        className="bg-red-600 text-white px-8 py-3 rounded-xl font-black text-sm hover:bg-red-700 transition-colors shadow-lg shadow-red-600/20"
                      >
                        نعم، حذف الطلب
                      </button>
                      <button 
                        onClick={() => setShowDeleteConfirm(false)}
                        className="bg-white text-gray-500 px-8 py-3 rounded-xl font-black text-sm border border-gray-200 hover:bg-gray-100 transition-colors"
                      >
                        إلغاء
                      </button>
                    </div>
                  </motion.div>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="w-full flex h-screen bg-brand-gray font-sans overflow-hidden">
      {/* Sidebar (Right side in RTL) */}
      <aside className="w-72 bg-brand-navy flex-col border-r-8 border-brand-gold hidden md:flex shrink-0">
        <div className="p-8 flex flex-col items-center gap-4">
          <div className="w-32 h-32 bg-white rounded-3xl flex items-center justify-center p-4 shadow-2xl rotate-3 hover:rotate-0 transition-transform duration-500 overflow-hidden">
            {appearance.logoUrl ? (
              <img src={appearance.logoUrl} alt="Logo" className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-full h-full border-4 border-brand-navy rounded-2xl flex flex-col items-center justify-center font-black text-brand-navy leading-tight select-none">
                <span className="text-4xl">{appearance.appName.charAt(0)}</span>
                <span className="text-xl -mt-1 font-mono">APP</span>
              </div>
            )}
          </div>
          <div className="text-center mt-2 px-4">
            <h1 className="text-xl font-black text-white tracking-tight uppercase leading-tight">{appearance.appName}</h1>
            <p className="text-[9px] text-white/50 font-mono tracking-widest mt-1 uppercase">DURRAT AL-MUNAWARAH</p>
          </div>
        </div>

        <nav className="flex-1 px-4 py-8 space-y-2">
          <button
            onClick={() => setActiveTab(Tab.EXTRACT)}
            className={`w-full flex items-center gap-4 px-6 py-4 rounded-2xl font-bold transition-all ${
              activeTab === Tab.EXTRACT 
              ? 'bg-brand-gold text-white shadow-lg shadow-brand-gold/20' 
              : 'text-white/60 hover:bg-white/5 hover:text-white'
            }`}
          >
            <Search className="w-5 h-5" />
            <span>الاستخراج والطباعة</span>
          </button>
          
          <button
            onClick={() => setActiveTab(Tab.LOG)}
            className={`w-full flex items-center gap-4 px-6 py-4 rounded-2xl font-bold transition-all ${
              activeTab === Tab.LOG 
              ? 'bg-brand-gold text-white shadow-lg shadow-brand-gold/20' 
              : 'text-white/60 hover:bg-white/5 hover:text-white'
            }`}
          >
            <Clock className="w-5 h-5" />
            <span>سجل المستلمين</span>
          </button>

          {userData?.role === 'admin' && (
            <button
              onClick={() => setActiveTab(Tab.USERS)}
              className={`w-full flex items-center gap-4 px-6 py-4 rounded-2xl font-bold transition-all ${
                activeTab === Tab.USERS 
                ? 'bg-brand-gold text-white shadow-lg shadow-brand-gold/20' 
                : 'text-white/60 hover:bg-white/5 hover:text-white'
              }`}
            >
              <ShieldCheck className="w-5 h-5" />
              <span>إدارة الحسابات</span>
            </button>
          )}

          {userData?.role === 'admin' && (
            <button
              onClick={() => setActiveTab(Tab.SETTINGS)}
              className={`w-full flex items-center gap-4 px-6 py-4 rounded-2xl font-bold transition-all ${
                activeTab === Tab.SETTINGS 
                ? 'bg-brand-gold text-white shadow-lg shadow-brand-gold/20' 
                : 'text-white/60 hover:bg-white/5 hover:text-white'
              }`}
            >
              <Building2 className="w-5 h-5" />
              <span>إعدادات النظام</span>
            </button>
          )}
        </nav>

        <div className="p-6 border-t border-white/5 bg-black/10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-brand-blue rounded-full flex items-center justify-center font-bold text-white shadow-inner">
              {userData?.fullName?.charAt(0)}
            </div>
            <div className="flex-1 overflow-hidden">
              <span className="block font-bold text-xs text-white truncate">{userData?.fullName}</span>
              <span className="block text-[10px] text-white/40 truncate leading-none uppercase">{userData?.role}</span>
            </div>
          </div>
          <button 
            onClick={() => signOut(auth)}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-white/10 text-white/60 hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30 transition-all font-bold text-sm"
          >
            <LogOut className="w-4 h-4" />
            تسجيل الخروج
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Mobile Header */}
        <header className="md:hidden bg-brand-navy p-4 flex items-center justify-between border-b-4 border-brand-gold">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center font-black text-brand-navy text-xs overflow-hidden">
               {appearance.logoUrl ? (
                 <img src={appearance.logoUrl} className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" />
               ) : (
                 appearance.appName.charAt(0)
               )}
             </div>
             <h1 className="text-white font-black text-sm">{appearance.appName}</h1>
          </div>
          <button onClick={() => signOut(auth)} className="text-white/60 p-2"><LogOut className="w-5 h-5" /></button>
        </header>

        {/* Mobile Nav */}
        <nav className="md:hidden bg-white border-b border-gray-200 grid grid-cols-3 divide-x divide-gray-100">
           <button onClick={() => setActiveTab(Tab.EXTRACT)} className={`py-4 flex flex-col items-center gap-1 ${activeTab === Tab.EXTRACT ? 'text-brand-gold' : 'text-gray-400'}`}>
              <Search className="w-5 h-5" />
              <span className="text-[10px] font-bold tracking-tighter">الاستخراج</span>
           </button>
           <button onClick={() => setActiveTab(Tab.LOG)} className={`py-4 flex flex-col items-center gap-1 ${activeTab === Tab.LOG ? 'text-brand-gold' : 'text-gray-400'}`}>
              <Clock className="w-5 h-5" />
              <span className="text-[10px] font-bold tracking-tighter">السجل</span>
           </button>
           <button onClick={() => setActiveTab(Tab.USERS)} className={`py-4 flex flex-col items-center gap-1 ${activeTab === Tab.USERS ? 'text-brand-gold' : 'text-gray-400'}`}>
              <ShieldCheck className="w-5 h-5" />
              <span className="text-[10px] font-bold tracking-tighter">الحسابات</span>
           </button>
        </nav>

        <main className="flex-1 p-6 md:p-10 overflow-y-auto bg-brand-gray scroll-smooth">
          <AnimatePresence mode="wait">
            {activeTab === Tab.EXTRACT && (
              <motion.div
                key="extract"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start h-full"
              >
              {/* Left Column: Tools */}
              <div className="md:col-span-12 lg:col-span-5 space-y-10">
                {/* Step 1: Data Integration */}
                <div className="relative">
                  <div className="absolute -right-4 top-0 w-12 h-12 bg-white rounded-2xl shadow-xl flex items-center justify-center z-10 border-4 border-brand-gray">
                    <span className="text-brand-navy font-black text-lg">01</span>
                  </div>
                  
                  <div className="bg-white rounded-[2rem] p-8 shadow-xl shadow-brand-navy/5 border border-white/60">
                    <h3 className="text-sm font-black text-brand-navy uppercase tracking-[0.2em] mb-6 flex items-center gap-3">
                      <div className="w-2 h-6 bg-brand-gold rounded-full"></div>
                      {userData?.role === 'admin' ? 'تحديث قاعدة البيانات' : 'قاعدة البيانات المزامنة'}
                    </h3>

                    {userData?.role === 'admin' ? (
                      // Admin Upload Interface
                      !pdfPages ? (
                        <div className="space-y-6">
                          <label className={`relative block border-4 border-dashed rounded-[2.5rem] cursor-pointer transition-all duration-500 overflow-hidden ${
                            isExtracting 
                            ? 'h-64 border-brand-gold bg-brand-navy/[0.03]' 
                            : 'h-48 border-brand-navy/10 hover:border-brand-gold bg-brand-navy/[0.01] group'
                          }`}>
                            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                              <AnimatePresence mode="wait">
                                {isExtracting ? (
                                  <motion.div 
                                    key="processing"
                                    initial={{ scale: 0.8, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    exit={{ scale: 1.2, opacity: 0 }}
                                    className="flex flex-col items-center w-full max-w-sm"
                                  >
                                    <div className="w-16 h-16 bg-brand-gold rounded-full flex items-center justify-center shadow-xl mb-6 animate-pulse">
                                      <Loader2 className="w-8 h-8 text-brand-navy animate-spin" />
                                    </div>
                                    <div className="w-full space-y-3">
                                      <div className="flex justify-between items-end">
                                        <span className="text-[10px] font-black text-brand-navy uppercase tracking-widest">{extractStatus}</span>
                                        <span className="text-sm font-mono font-black text-brand-gold">{extractProgress}%</span>
                                      </div>
                                      <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
                                        <motion.div 
                                          className="h-full bg-brand-gold"
                                          initial={{ width: 0 }}
                                          animate={{ width: `${extractProgress}%` }}
                                          transition={{ duration: 0.3 }}
                                        />
                                      </div>
                                      <p className="text-[9px] text-gray-400 font-bold uppercase tracking-tighter">AI Processing Engine Active</p>
                                    </div>
                                  </motion.div>
                                ) : (
                                  <motion.div 
                                    key="idle"
                                    initial={{ y: 10, opacity: 0 }}
                                    animate={{ y: 0, opacity: 1 }}
                                    className="flex flex-col items-center"
                                  >
                                    <div className="w-16 h-16 bg-white border-2 border-brand-navy/5 rounded-2xl flex items-center justify-center shadow-lg mb-4 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500">
                                      <Upload className="w-8 h-8 text-brand-navy group-hover:text-brand-gold" />
                                    </div>
                                    <h4 className="text-lg font-black text-brand-navy mb-1">رفع كشوفات الـ PDF الأصلية</h4>
                                    <p className="text-xs text-gray-400 font-medium">قم بسحب الملف هنا أو اضغط للاختيار</p>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                            <input type="file" className="hidden" accept="application/pdf" onChange={handleFileUpload} disabled={isExtracting} />
                          </label>
                          
                          {isExtracting && (
                            <motion.div 
                               initial={{ opacity: 0, y: 10 }}
                               animate={{ opacity: 1, y: 0 }}
                               className="flex items-center gap-3 bg-brand-navy p-4 rounded-2xl shadow-xl border-l-4 border-brand-gold"
                            >
                               <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center">
                                  <FileText className="w-5 h-5 text-brand-gold animate-bounce" />
                               </div>
                               <div>
                                  <p className="text-white text-xs font-black">جاري المعالجة الرقمية للملف: <span className="text-brand-gold">{fileName}</span></p>
                                  <p className="text-white/40 text-[9px] font-bold uppercase tracking-widest mt-0.5">Vectorizing & Indexing Content...</p>
                               </div>
                            </motion.div>
                          )}
                        </div>
                      ) : (
                        <div className="bg-emerald-50/50 border-2 border-emerald-100 rounded-3xl p-6 flex items-center justify-between group">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-500/10 border border-emerald-100">
                              <CheckCircle className="w-7 h-7 text-emerald-500" />
                            </div>
                            <div className="overflow-hidden">
                              <p className="text-sm font-black text-brand-navy line-clamp-1 truncate max-w-[150px]">{fileName}</p>
                              <p className="text-[10px] uppercase font-mono text-emerald-500 font-bold tracking-widest mt-0.5">READY_FOR_EXTRACTION</p>
                            </div>
                          </div>
                          <button 
                            onClick={() => { setPdfPages(null); setSearchResult(null); setOriginalFile(null); }}
                            className="px-4 py-2 bg-white border border-red-50 text-red-500 rounded-xl text-[10px] font-black uppercase hover:bg-red-500 hover:text-white transition-all shadow-sm flex items-center gap-2"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            إلغاء الملف
                          </button>
                        </div>
                      )
                    ) : (
                      // Regular User View
                      fileName ? (
                        <div className="bg-emerald-50/50 border-2 border-emerald-100 rounded-3xl p-6">
                           <div className="flex items-center gap-5">
                              <div className="w-14 h-14 bg-white rounded-2xl flex items-center justify-center shadow-xl border border-emerald-100 rotate-3">
                                 <FileText className="w-8 h-8 text-brand-navy" />
                              </div>
                              <div className="flex-1 overflow-hidden">
                                 <span className="block text-[10px] text-emerald-600 font-black uppercase tracking-widest mb-1">Active Scan Document</span>
                                 <h4 className="text-brand-navy font-black text-lg truncate">{fileName}</h4>
                                 <div className="flex items-center gap-2 mt-2">
                                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping"></div>
                                    <span className="text-[9px] text-gray-400 font-bold uppercase tracking-tighter">Synced with server | {lastUploadedBy}</span>
                                 </div>
                              </div>
                           </div>
                        </div>
                      ) : (
                        <div className="p-10 bg-gray-50/50 border-4 border-dashed border-gray-100 rounded-[2.5rem] text-center">
                           <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm">
                              <Clock className="w-8 h-8 text-gray-200 animate-pulse" />
                           </div>
                           <p className="text-gray-400 font-bold text-sm">بانتظار قيام المدير برفع كشف الـ PDF اليومي للبدء في عمليات المطابقة...</p>
                        </div>
                      )
                    )}
                  </div>
                </div>

                {/* Step 2: Intelligent Action */}
                <div className={`relative transition-all duration-700 ${!pdfPages ? 'opacity-30 scale-[0.98] pointer-events-none' : 'opacity-100'}`}>
                  <div className="absolute -right-4 top-0 w-12 h-12 bg-white rounded-2xl shadow-xl flex items-center justify-center z-10 border-4 border-brand-gray">
                    <span className="text-brand-navy font-black text-lg">02</span>
                  </div>

                  <div className="bg-brand-navy rounded-[2.5rem] p-10 shadow-2xl shadow-brand-navy/30 relative overflow-hidden">
                    {/* Background Decorative Element */}
                    <div className="absolute top-0 left-0 w-64 h-64 bg-white/5 rounded-full -translate-x-1/2 -translate-y-1/2 blur-3xl"></div>
                    
                    <div className="relative z-10 space-y-8">
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <h3 className="text-brand-gold font-black uppercase tracking-[0.2em] text-xs">Action Center</h3>
                          <h2 className="text-2xl font-black text-white">البحث الذكي عن السائق</h2>
                        </div>
                        <Search className="w-8 h-8 text-white/20" />
                      </div>

                      <div className="space-y-5">
                        <div className="relative group">
                          <div className="absolute -inset-1 bg-brand-gold/10 rounded-[2rem] blur opacity-0 group-hover:opacity-100 transition duration-500"></div>
                          <input
                            type="text"
                            placeholder="أدخل رقم الهوية أو الاسم..."
                            className="relative w-full px-8 py-7 bg-white/10 border-2 border-white/20 rounded-3xl text-2xl font-black text-white placeholder:text-white/30 focus:border-brand-gold focus:bg-white/20 outline-none transition-all shadow-inner backdrop-blur-md text-center"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                          />
                        </div>
                        <button
                          onClick={handleSearch}
                          disabled={isSearching || !searchQuery}
                          className="w-full py-6 bg-brand-gold text-brand-navy rounded-3xl font-black text-xl hover:scale-[1.01] hover:shadow-2xl hover:shadow-brand-gold/40 active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-20 shadow-lg shadow-brand-gold/20"
                        >
                          {isSearching ? (
                            <Loader2 className="w-8 h-8 animate-spin" />
                          ) : (
                            <>
                              <Search className="w-7 h-7" />
                              <span>بدء البحث المتقدم</span>
                            </>
                          )}
                        </button>
                      </div>

                      <div className="flex flex-wrap gap-3">
                         <span className="px-4 py-2 bg-white/5 border border-white/10 rounded-full text-[10px] text-white/40 font-bold uppercase tracking-widest">NORMALIZATION_ON</span>
                         <span className="px-4 py-2 bg-white/5 border border-white/10 rounded-full text-[10px] text-white/40 font-bold uppercase tracking-widest">FUZZY_MATCH_READY</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="mt-8 space-y-4">
                    {isSearching && searchStage && (
                      <motion.div 
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-center gap-4 bg-brand-navy/5 p-6 rounded-3xl border border-brand-navy/10 shadow-lg shadow-brand-navy/5"
                      >
                        <div className="w-10 h-10 bg-white rounded-xl shadow-sm flex items-center justify-center">
                           <Loader2 className="w-5 h-5 animate-spin text-brand-navy" />
                        </div>
                        <span className="text-sm font-black text-brand-navy uppercase tracking-wide animate-pulse">{searchStage}</span>
                      </motion.div>
                    )}

                    {searchResult && (
                      <div className="flex items-center justify-between bg-emerald-50 p-6 rounded-3xl border-2 border-emerald-100 shadow-xl shadow-emerald-500/5">
                        <div className="text-xs text-emerald-800 flex items-center gap-4 font-bold">
                          <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
                            <CheckCircle className="w-6 h-6 text-white" />
                          </div>
                          <div>
                             <p className="text-sm font-black">تم تحديد موقع السجل</p>
                             <p className="text-[10px] uppercase opacity-60">Result verified on Page {searchResult.pageNumber}</p>
                          </div>
                        </div>
                        
                        <button 
                          onClick={() => { setSearchResult(null); setEditedResult(null); setSearchQuery(''); }}
                          className="px-5 py-2.5 bg-white border border-emerald-200 text-emerald-600 rounded-xl text-xs font-black hover:bg-emerald-500 hover:text-white transition-all shadow-sm"
                        >
                          مسح النتائج
                        </button>
                      </div>
                    )}

                    <AnimatePresence>
                      {error && (
                        <motion.div
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="bg-red-50 border-r-8 border-red-500 p-6 rounded-3xl text-sm text-red-800 font-black shadow-xl shadow-red-500/5"
                        >
                          {error}
                        </motion.div>
                      )}
                      {success && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.9, y: 10 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.9, y: -10 }}
                          className="bg-emerald-600 p-6 rounded-3xl text-white font-bold flex items-center gap-6 shadow-2xl shadow-emerald-600/20 border-2 border-white/20"
                        >
                          <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center shrink-0 backdrop-blur-md">
                            <CheckCircle className="w-7 h-7 text-white" />
                          </div>
                          <div>
                            <p className="text-base font-black">{success}</p>
                            <p className="text-[10px] opacity-70 uppercase tracking-[0.2em] mt-1 font-bold">Transaction Confirmed & Archived</p>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </div>

              <div className="md:col-span-12 lg:col-span-7 h-full lg:sticky lg:top-0">
                <AnimatePresence mode="wait">
                  {(searchResult && editedResult) ? (
                    <motion.section
                      key="result-edit"
                      initial={{ opacity: 0, scale: 0.98, y: 20 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="bg-white shadow-2xl rounded-[2.5rem] overflow-hidden border-2 border-brand-navy/5 flex flex-col h-full relative"
                    >
                      <div className="absolute top-0 right-0 w-32 h-32 bg-brand-gold/5 rounded-bl-[5rem] -z-0"></div>
                      
                      <div className="px-10 py-8 border-b border-gray-100 flex justify-between items-center relative z-10">
                        <div>
                          <h2 className="font-black text-brand-navy uppercase tracking-tight flex items-center gap-3 text-lg md:text-xl">
                            <div className="w-10 h-10 bg-brand-navy rounded-xl flex items-center justify-center text-white shadow-lg shadow-brand-navy/20">
                              <Users className="w-5 h-5" />
                            </div>
                            مراجعة وتدقيق بيانات المستخرج
                          </h2>
                          <div className="flex items-center gap-2 mt-2">
                            <span className="w-2 h-2 bg-brand-gold rounded-full animate-ping"></span>
                            <span className="text-[10px] text-gray-400 font-bold tracking-widest uppercase">Manual Verification Required | {appearance.appName}</span>
                          </div>
                        </div>
                        <div className="flex flex-col items-end">
                          <span className="text-[10px] bg-brand-navy text-white px-4 py-1.5 rounded-full font-mono font-bold shadow-md">READY_FOR_CONFIRMATION</span>
                        </div>
                      </div>
                      
                      <div className="flex-1 p-8 md:p-12 relative z-10 space-y-10 overflow-y-auto">
                        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-5 flex gap-4 items-center">
                          <AlertCircle className="w-6 h-6 text-amber-600 shrink-0" />
                          <p className="text-[11px] text-amber-900 font-bold leading-relaxed">
                            يرجى التأكد من صحة البيانات المستخرجة أدناه. يمكنك تعديل أي حقل مباشرة إذا لزم الأمر قبل الضغط على زر التأكيد النهائي للحفظ في الأرشيف.
                          </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                          <div className="md:col-span-2 space-y-4">
                            <div className="relative">
                              <span className="absolute -top-3 right-6 px-3 bg-white text-[10px] text-brand-gold font-black uppercase tracking-[0.2em] border border-brand-gold/20 rounded-full z-20">الاسم الرباعي الكامل</span>
                              <div className="relative group">
                                <div className="absolute -inset-1 bg-brand-gold/5 rounded-[2rem] blur opacity-0 group-focus-within:opacity-100 transition-all"></div>
                                <input 
                                  type="text"
                                  value={editedResult.fullName}
                                  onChange={(e) => setEditedResult({...editedResult, fullName: e.target.value})}
                                  className="relative w-full bg-white border-2 border-gray-100 focus:border-brand-gold px-8 py-8 rounded-[2rem] text-2xl font-black text-brand-navy text-center md:text-right outline-none transition-all shadow-inner"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="space-y-6">
                            <div className="flex flex-col gap-2">
                                <span className="text-[10px] text-gray-400 font-black uppercase tracking-widest flex items-center gap-2">
                                  <ShieldCheck className="w-3 h-3 text-brand-gold" />
                                  رقم الهوية الوطنية / الإقامة
                                </span>
                                <input 
                                  type="text"
                                  value={editedResult.idNumber}
                                  onChange={(e) => setEditedResult({...editedResult, idNumber: e.target.value})}
                                  className="w-full bg-gray-50 border-2 border-transparent focus:border-brand-navy/20 p-5 rounded-2xl font-mono font-black text-brand-navy text-xl outline-none transition-all"
                                />
                            </div>

                            <div className="flex flex-col gap-2">
                                <span className="text-[10px] text-gray-400 font-black uppercase tracking-widest flex items-center gap-2">
                                  <Search className="w-3 h-3 text-brand-gold" />
                                  نوع الوثيقة الرسمية
                                </span>
                                <div className="grid grid-cols-3 gap-2 p-1.5 bg-gray-50 rounded-2xl border-2 border-transparent focus-within:border-brand-navy/10 transition-all">
                                  <button 
                                    onClick={() => setEditedResult({...editedResult, idType: 'رقم إقامة'})}
                                    className={`py-3.5 rounded-xl text-[10px] font-black transition-all ${editedResult.idType === 'رقم إقامة' ? 'bg-brand-navy text-white shadow-lg' : 'text-gray-400 hover:bg-white'}`}
                                  >
                                    رقم إقامة
                                  </button>
                                  <button 
                                    onClick={() => setEditedResult({...editedResult, idType: 'هوية وطنية'})}
                                    className={`py-3.5 rounded-xl text-[10px] font-black transition-all ${editedResult.idType === 'هوية وطنية' ? 'bg-brand-navy text-white shadow-lg' : 'text-gray-400 hover:bg-white'}`}
                                  >
                                    هوية وطنية
                                  </button>
                                  <button 
                                    onClick={() => setEditedResult({...editedResult, idType: 'رقم حدود'})}
                                    className={`py-3.5 rounded-xl text-[10px] font-black transition-all ${editedResult.idType === 'رقم حدود' ? 'bg-brand-navy text-white shadow-lg' : 'text-gray-400 hover:bg-white'}`}
                                  >
                                    رقم حدود
                                  </button>
                                </div>
                            </div>
                          </div>

                          <div className="space-y-6">
                            <div className="flex flex-col gap-2">
                                <span className="text-[10px] text-gray-400 font-black uppercase tracking-widest flex items-center gap-2">
                                  <Clock className="w-3 h-3 text-brand-gold" />
                                  تاريخ انتهاء الصلاحية (اختياري)
                                </span>
                                <input 
                                  type="text"
                                  value={editedResult.expiryDate || ''}
                                  onChange={(e) => setEditedResult({...editedResult, expiryDate: e.target.value})}
                                  placeholder="مثال: 1445/05/12"
                                  className="w-full bg-gray-50 border-2 border-transparent focus:border-brand-navy/20 p-5 rounded-2xl font-mono font-black text-brand-navy text-xl outline-none transition-all placeholder:text-gray-300"
                                />
                            </div>

                            <div className="flex flex-col gap-2 text-left md:text-right">
                                <span className="text-[10px] text-gray-400 font-black uppercase tracking-widest flex items-center gap-2 justify-end">
                                  <FileText className="w-3 h-3 text-brand-gold" />
                                  تموقعه في الكشف (المؤرشف)
                                </span>
                                <div className="bg-gray-100/50 p-5 rounded-2xl border-2 border-transparent flex items-center justify-center md:justify-end gap-3 text-lg font-bold text-brand-navy opacity-60">
                                  <span>صفحة رقم</span>
                                  <span className="bg-brand-navy text-white px-3 py-0.5 rounded-lg font-mono">{editedResult.pageNumber}</span>
                                </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="p-8 md:p-10 bg-brand-navy/[0.02] border-t-2 border-gray-100 flex flex-col md:flex-row gap-5 relative z-10 backdrop-blur-sm">
                        <button 
                          disabled={printingPage || !originalFile}
                          className={`flex-1 py-5 rounded-2xl font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-3 shadow-xl disabled:opacity-50 ${
                            !originalFile 
                            ? 'bg-gray-100 text-gray-400 border-2 border-transparent border-dashed cursor-not-allowed' 
                            : 'bg-white border-2 border-brand-navy text-brand-navy hover:bg-brand-navy hover:text-white shadow-brand-navy/5'
                          }`}
                          onClick={printOriginalPage}
                          title={!originalFile ? "خيار طباعة الصفحة بصيغتها الأصلية متاح فقط للمدير الذي قام برفع الملف الحالي" : ""}
                        >
                          {printingPage ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />}
                          {originalFile ? 'طباعة الصفحة الأصلية' : 'الطباعة الأصلية غير متاحة'}
                        </button>
                        <button 
                          className="flex-[2] bg-brand-navy text-brand-gold py-5 rounded-2xl font-black hover:scale-[1.02] hover:shadow-2xl hover:shadow-brand-navy/30 uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-3 shadow-2xl shadow-brand-navy/20 border-2 border-brand-gold/30"
                          onClick={confirmDelivery}
                        >
                          <CheckCircle className="w-6 h-6" />
                          تأكيد البيانات والأرشفة
                        </button>
                      </div>
                    </motion.section>
                  ) : (
                    <motion.div 
                      key="empty"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="h-full bg-white/50 border-4 border-dashed border-gray-200 rounded-[3rem] flex flex-col items-center justify-center p-12 text-center group transition-colors hover:border-brand-navy/10"
                    >
                      <div className="w-32 h-32 bg-gray-100 rounded-full flex items-center justify-center mb-8 shadow-inner group-hover:scale-110 transition-transform duration-500">
                         <div className="relative">
                            <Users className="w-16 h-16 text-gray-300 group-hover:text-brand-gold transition-colors" />
                            <div className="absolute -bottom-2 -right-2 w-8 h-8 bg-brand-navy rounded-lg flex items-center justify-center shadow-lg transform rotate-12 group-hover:rotate-0 transition-transform">
                               <Search className="w-4 h-4 text-white" />
                            </div>
                         </div>
                      </div>
                      <h3 className="text-2xl font-black text-gray-400 mb-4">مركز معالجة البيانات الذكي</h3>
                      <div className="max-w-md space-y-4">
                        <p className="text-gray-400 font-medium leading-relaxed">
                          عند قيامك بالبحث، سيقوم النظام تلقائياً باسترجاع بيانات السائق الكاملة من كشوفات الـ PDF المرفوعة وعرضها هنا للمراجعة والطباعة.
                        </p>
                        <div className="flex items-center justify-center gap-6 pt-4">
                           <div className="flex flex-col items-center gap-2">
                              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-500 flex items-center justify-center border border-emerald-100">
                                 <Upload className="w-5 h-5" />
                              </div>
                              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">1. ارفع الملف</span>
                           </div>
                           <div className="w-8 h-px bg-gray-200"></div>
                           <div className="flex flex-col items-center gap-2">
                              <div className="w-10 h-10 rounded-xl bg-orange-50 text-orange-500 flex items-center justify-center border border-orange-100">
                                 <Search className="w-5 h-5" />
                              </div>
                              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">2. ابحث عن السائق</span>
                           </div>
                           <div className="w-8 h-px bg-gray-200"></div>
                           <div className="flex flex-col items-center gap-2">
                              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-500 flex items-center justify-center border border-blue-100">
                                 <Printer className="w-5 h-5" />
                              </div>
                              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">3. راجع وأكد</span>
                           </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}

          {activeTab === Tab.LOG && (
            <motion.div
              key="log"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="bg-white rounded-3xl shadow-2xl border-2 border-brand-navy overflow-hidden">
                <div className="p-8 border-b-2 border-gray-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-gray-50">
                  <div>
                    <h2 className="text-2xl font-black text-brand-navy flex items-center gap-3">
                      <Users className="w-7 h-7" />
                      سجل المستلمين الرسمي
                    </h2>
                    <p className="text-sm text-gray-500 font-medium">الأرشيف التاريخي المركزي (Firestore Sync)</p>
                  </div>
                  
                  <button 
                    onClick={exportToExcel}
                    className="bg-brand-navy text-white px-8 py-3 rounded-xl font-black text-sm flex items-center gap-3 hover:bg-opacity-90 transition-all active:scale-95 shadow-lg"
                  >
                    <Download className="w-5 h-5" />
                    تصدير السجل الكامل (Excel)
                  </button>
                </div>

                <div className="overflow-x-auto p-4 md:p-8">
                  <table className="w-full text-right border-collapse">
                    <thead>
                      <tr className="bg-brand-navy text-white">
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">الاسم الكامل للسائق</th>
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">رقم الهوية</th>
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">النوع</th>
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">وقت الاستلام</th>
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">الموظف</th>
                        {userData?.role === 'admin' && <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-center">الإجراء</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-gray-100">
                      {recipients.length > 0 ? (
                        recipients.map((record) => (
                          <tr key={record.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-6 py-5 font-bold text-brand-navy">{record.fullName}</td>
                            <td className="px-6 py-5 font-mono text-sm font-bold text-gray-600">{record.idNumber}</td>
                            <td className="px-6 py-5">
                              <span className={`px-3 py-1 rounded-md text-[10px] font-black uppercase tracking-tighter ${record.idType === 'رقم إقامة' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                                {record.idType}
                              </span>
                            </td>
                            <td className="px-6 py-5 text-sm font-mono text-gray-500 uppercase">{formatDate(record.receivedAt)}</td>
                            <td className="px-6 py-5 text-xs text-gray-400 font-bold">{record.createdByName || record.createdByEmail}</td>
                            {userData?.role === 'admin' && (
                              <td className="px-6 py-5 text-center">
                                <button 
                                  onClick={() => setRecordToDelete(record)}
                                  className="w-10 h-10 rounded-xl border border-gray-100 flex items-center justify-center text-gray-300 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all mx-auto shadow-sm"
                                  title="حذف السجل"
                                >
                                  <Trash2 className="w-5 h-5" />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="px-6 py-20 text-center text-gray-300 italic">
                            <div className="flex flex-col items-center gap-4">
                              <Users className="w-16 h-16 opacity-30" />
                              <span className="text-xl font-black opacity-30 tracking-tight">لا يوجد سجلات مستلمة حالياً</span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === Tab.USERS && (
            <motion.div
              key="users"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="bg-white rounded-3xl shadow-2xl border-2 border-brand-navy overflow-hidden">
                <div className="p-8 border-b-2 border-gray-200 bg-gray-50">
                  <h2 className="text-2xl font-black text-brand-navy flex items-center gap-3">
                    <UserCheck className="w-7 h-7" />
                    إدارة الحسابات والطلبات
                  </h2>
                  <p className="text-sm text-gray-500 font-medium">مراجعة طلبات الانضمام وتعديل صلاحيات الموظفين</p>
                </div>

                <div className="overflow-x-auto p-8">
                  <table className="w-full text-right border-collapse">
                    <thead>
                      <tr className="bg-brand-navy text-white">
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">الاسم</th>
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">البريد الإلكتروني</th>
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">الحالة</th>
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-right">الدور</th>
                        <th className="px-6 py-4 font-black uppercase text-xs tracking-widest text-center">الإجراءات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-gray-100">
                      {allUsers.map((u) => (
                        <tr key={u.uid} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-5 font-bold text-brand-navy">{u.fullName}</td>
                          <td className="px-6 py-5 font-mono text-sm">{u.email}</td>
                          <td className="px-6 py-5">
                            <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${u.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                              {u.status === 'approved' ? 'مفعل' : 'قيد الانتظار'}
                            </span>
                          </td>
                          <td className="px-6 py-5 font-bold text-xs uppercase tracking-widest">{u.role === 'admin' ? 'مدير' : 'موظف'}</td>
                          <td className="px-6 py-5 text-center flex items-center justify-center gap-2">
                            {u.status === 'pending' && (
                              <button 
                                onClick={() => approveUser(u.uid)}
                                className="bg-emerald-500 text-white px-4 py-1.5 rounded-lg text-xs font-black hover:bg-emerald-600 transition-all"
                              >
                                قبول الطلب
                              </button>
                            )}
                            {!ADMIN_EMAILS.some(e => e.toLowerCase() === u.email.toLowerCase()) && (
                              <button 
                                onClick={() => setUserRecordToDelete(u)}
                                className="flex items-center gap-2 bg-red-50 text-red-600 px-4 py-2 rounded-xl text-xs font-black hover:bg-red-600 hover:text-white transition-all shadow-sm group"
                              >
                                <Trash2 className="w-4 h-4 group-hover:scale-110 transition-transform" />
                                حذف الحساب
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === Tab.SETTINGS && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="bg-white rounded-3xl shadow-2xl border-2 border-brand-navy overflow-hidden">
                <div className="p-8 border-b-2 border-gray-200 bg-gray-50">
                  <h2 className="text-2xl font-black text-brand-navy flex items-center gap-3">
                    <Building2 className="w-7 h-7" />
                    إعدادات المظهر والهوية
                  </h2>
                  <p className="text-sm text-gray-500 font-medium">تخصيص ألوان وشعار النظام ليتماشى مع هوية الشركة</p>
                </div>

                <div className="p-8 space-y-8 max-w-2xl">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-2">
                      <label className="block text-sm font-bold text-gray-700">اللون الرئيسي (Navy)</label>
                      <div className="flex gap-4 items-center">
                        <input 
                          type="color" 
                          value={appearance.primaryColor}
                          onChange={(e) => setAppearance(prev => ({ ...prev, primaryColor: e.target.value }))}
                          className="w-12 h-12 rounded-lg cursor-pointer border-2 border-gray-200"
                        />
                        <input 
                          type="text" 
                          value={appearance.primaryColor}
                          onChange={(e) => setAppearance(prev => ({ ...prev, primaryColor: e.target.value }))}
                          className="flex-1 bg-gray-50 border-2 border-gray-100 px-4 py-2 rounded-xl font-mono text-sm uppercase"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="block text-sm font-bold text-gray-700">اللون الثانوي (Gold)</label>
                      <div className="flex gap-4 items-center">
                        <input 
                          type="color" 
                          value={appearance.secondaryColor}
                          onChange={(e) => setAppearance(prev => ({ ...prev, secondaryColor: e.target.value }))}
                          className="w-12 h-12 rounded-lg cursor-pointer border-2 border-gray-200"
                        />
                        <input 
                          type="text" 
                          value={appearance.secondaryColor}
                          onChange={(e) => setAppearance(prev => ({ ...prev, secondaryColor: e.target.value }))}
                          className="flex-1 bg-gray-50 border-2 border-gray-100 px-4 py-2 rounded-xl font-mono text-sm uppercase"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-bold text-gray-700">اسم التطبيق</label>
                    <input 
                      type="text" 
                      value={appearance.appName}
                      onChange={(e) => setAppearance(prev => ({ ...prev, appName: e.target.value }))}
                      className="w-full bg-gray-50 border-2 border-gray-100 px-4 py-3 rounded-xl font-bold"
                      placeholder="أدخل اسم الشركة أو النظام"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-bold text-gray-700">الشعار الخاص بالشركة</label>
                    <div className="flex flex-col md:flex-row gap-6 items-center bg-gray-50 p-6 rounded-2xl border-2 border-dashed border-gray-200">
                      <div className="w-32 h-32 bg-white border-2 border-brand-gold rounded-2xl flex items-center justify-center p-3 shadow-xl overflow-hidden relative group">
                        {appearance.logoUrl ? (
                          <img src={appearance.logoUrl} className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" />
                        ) : (
                          <Building2 className="w-12 h-12 text-gray-200" />
                        )}
                        <label className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                          <span className="text-white text-[10px] font-bold">تغيير</span>
                          <input 
                            type="file" 
                            accept="image/*" 
                            className="hidden" 
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                if (file.size > 500 * 1024) {
                                  alert('حجم الصورة كبير جداً، يرجى اختيار صورة أقل من 500 كيلوبايت.');
                                  return;
                                }
                                const reader = new FileReader();
                                reader.onloadend = () => {
                                  setAppearance(prev => ({ ...prev, logoUrl: reader.result as string }));
                                };
                                reader.readAsDataURL(file);
                              }
                            }}
                          />
                        </label>
                      </div>
                      <div className="flex-1 space-y-4 w-full">
                        <div className="space-y-1">
                          <p className="text-sm font-bold text-brand-navy">اختر ملف الصورة</p>
                          <p className="text-[10px] text-gray-400">يفضل استخدام ملف PNG شفاف وبحجم أقل من 500KB لضمان سرعة التحميل.</p>
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => document.getElementById('logo-upload-input')?.click()}
                            className="bg-white border-2 border-brand-navy text-brand-navy px-4 py-2 rounded-xl text-xs font-black shadow-sm hover:bg-brand-navy hover:text-white transition-all flex items-center gap-2"
                          >
                            <Upload className="w-4 h-4" />
                            تغير الشعار
                          </button>
                          {appearance.logoUrl && (
                            <button 
                              onClick={() => setAppearance(prev => ({ ...prev, logoUrl: '' }))}
                              className="bg-red-50 text-red-600 px-4 py-2 rounded-xl text-xs font-black hover:bg-red-100 transition-all"
                            >
                              حذف
                            </button>
                          )}
                        </div>
                        <input id="logo-upload-input" type="file" accept="image/*" className="hidden" onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            if (file.size > 500 * 1024) {
                              alert('حجم الصورة كبير جداً، يرجى اختيار صورة أقل من 500 كيلوبايت.');
                              return;
                            }
                            const reader = new FileReader();
                            reader.onloadend = () => {
                              setAppearance(prev => ({ ...prev, logoUrl: reader.result as string }));
                            };
                            reader.readAsDataURL(file);
                          }
                        }} />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-bold text-gray-700">رابط الشعار البديل (اختياري)</label>
                    <input 
                      type="text" 
                      value={appearance.logoUrl.startsWith('data:') ? '' : appearance.logoUrl}
                      onChange={(e) => setAppearance(prev => ({ ...prev, logoUrl: e.target.value }))}
                      className="w-full bg-gray-50 border-2 border-gray-100 px-4 py-3 rounded-xl text-sm"
                      placeholder="https://example.com/logo.png"
                    />
                  </div>

                  <div className="pt-6 border-t border-gray-100">
                    <button 
                      onClick={async () => {
                        try {
                          await setDoc(doc(db, 'config', 'appearance'), appearance);
                          alert('تم حفظ الإعدادات بنجاح! سيتم تطبيق التغييرات فوراً على جميع المستخدمين.');
                        } catch (err) {
                          handleFirestoreError(err, OperationType.UPDATE, 'config/appearance');
                        }
                      }}
                      className="bg-brand-navy text-white px-10 py-4 rounded-xl font-black shadow-xl hover:shadow-brand-navy/20 transition-all active:scale-95 flex items-center gap-3 w-full md:w-auto"
                    >
                      <CheckCircle className="w-5 h-5 text-brand-gold" />
                      حفظ إعدادات الهوية
                    </button>
                  </div>
                </div>
                
                <div className="bg-amber-50 p-8 border-t-2 border-amber-100">
                  <div className="flex gap-4 items-start">
                    <AlertCircle className="w-6 h-6 text-amber-600 shrink-0" />
                    <div>
                      <h4 className="font-bold text-amber-900 mb-1">تنبيه المزامنة</h4>
                      <p className="text-sm text-amber-800 leading-relaxed">
                        هذه الإعدادات "عالمية" (Global)، مما يعني أنها ستؤثر على شكل التطبيق لدى جميع الموظفين بمجرد الحفظ. يرجى التأكد من اختيار ألوان ذات تباين جيد لضمان سهولة القراءة.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Delete Confirmation Modal for User Recipient Record */}
        <AnimatePresence>
          {recordToDelete && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setRecordToDelete(null)}
                className="absolute inset-0 bg-brand-navy/60 backdrop-blur-sm px-4"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden border-2 border-red-50"
              >
                <div className="p-8 pb-0 text-center">
                  <div className="w-20 h-20 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner animate-pulse">
                    <Trash2 className="w-10 h-10" />
                  </div>
                  <h3 className="text-2xl font-black text-brand-navy mb-3">تأكيد الحذف النهائي</h3>
                  <p className="text-gray-500 font-medium leading-relaxed">
                    هل أنت متأكد من رغبتك في حذف سجل السائق <br />
                    <span className="text-red-600 font-black">"{recordToDelete.fullName}"</span>؟ <br />
                    هذا الإجراء لا يمكن التراجع عنه وسيتم حذفه من الأرشيف نهائياً.
                  </p>
                </div>
                
                <div className="p-8 flex gap-4">
                  <button
                    onClick={() => setRecordToDelete(null)}
                    className="flex-1 px-6 py-4 bg-gray-50 text-gray-500 rounded-2xl font-black hover:bg-gray-100 transition-all"
                  >
                    إلغاء
                  </button>
                  <button
                    onClick={async () => {
                      if (recordToDelete) {
                        try {
                          const idToDelete = recordToDelete.id;
                          setRecordToDelete(null);
                          await deleteDoc(doc(db, 'recipients', idToDelete));
                          setSuccess('تم حذف السجل بنجاح.');
                          setTimeout(() => setSuccess(null), 4000);
                        } catch (err) {
                          handleFirestoreError(err, OperationType.DELETE, `recipients/${recordToDelete.id}`);
                        }
                      }
                    }}
                    className="flex-[1.5] px-6 py-4 bg-red-600 text-white rounded-2xl font-black shadow-xl shadow-red-200 hover:bg-red-700 hover:shadow-red-300 transition-all active:scale-95 flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-5 h-5" />
                    حذف السجل
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Delete Confirmation Modal for User Account */}
        <AnimatePresence>
          {userRecordToDelete && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setUserRecordToDelete(null)}
                className="absolute inset-0 bg-brand-navy/60 backdrop-blur-sm px-4"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden border-2 border-red-50"
              >
                <div className="p-8 pb-0 text-center">
                  <div className="w-20 h-20 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner animate-pulse">
                    <LogOut className="w-10 h-10" />
                  </div>
                  <h3 className="text-2xl font-black text-brand-navy mb-3">حذف حساب موظف</h3>
                  <p className="text-gray-500 font-medium leading-relaxed">
                    هل أنت متأكد من رغبتك في حذف حساب الموظف <br />
                    <span className="text-red-600 font-black">"{userRecordToDelete.fullName}"</span>؟ <br />
                    لن يتمكن هذا المستخدم من الدخول للنظام بعد الآن.
                  </p>
                </div>
                
                <div className="p-8 flex gap-4">
                  <button
                    onClick={() => setUserRecordToDelete(null)}
                    className="flex-1 px-6 py-4 bg-gray-50 text-gray-500 rounded-2xl font-black hover:bg-gray-100 transition-all"
                  >
                    إلغاء
                  </button>
                  <button
                    onClick={async () => {
                      if (userRecordToDelete) {
                        try {
                          const uid = userRecordToDelete.uid;
                          setUserRecordToDelete(null);
                          await deleteDoc(doc(db, 'users', uid));
                          setSuccess('تم حذف حساب المستخدم بنجاح.');
                          setTimeout(() => setSuccess(null), 4000);
                        } catch (err) {
                          handleFirestoreError(err, OperationType.DELETE, `users/${userRecordToDelete.uid}`);
                        }
                      }
                    }}
                    className="flex-[1.5] px-6 py-4 bg-red-600 text-white rounded-2xl font-black shadow-xl shadow-red-200 hover:bg-red-700 hover:shadow-red-300 transition-all active:scale-95 flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-5 h-5" />
                    تأكيد الحذف
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
        </main>

        {/* Footer */}
        <footer className="bg-white border-t border-gray-200 px-8 py-4 flex flex-col md:flex-row-reverse justify-between items-center text-[11px] text-gray-400 font-bold gap-3">
          <div className="text-center md:text-right">
            جميع الحقوق محفوظة لمكتب التشغيل في شركة درة المنورة &copy; {new Date().getFullYear()}
          </div>
          <div className="text-center md:text-left opacity-70">
            تصميم فريق مكتب التشغيل 
            <span className="mx-2 text-gray-200">|</span> 
            <span className="text-[9px] font-mono">STATUS: READY_PRO_V2.6</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

