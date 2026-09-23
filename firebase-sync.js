import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, getDocs, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBKi5YUhxka4nx_7s8IZ72eX5zGMoEIndY",
  authDomain: "flipfeed-f8435.firebaseapp.com",
  projectId: "flipfeed-f8435",
  storageBucket: "flipfeed-f8435.firebasestorage.app",
  messagingSenderId: "1092687653458",
  appId: "1:1092687653458:web:1237261d98f66f3d780d8b"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, {
  ignoreUndefinedProperties: true,
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

let user = null;
const userRoot = () => doc(db, "users", user.uid);
const deckRoot = deckId => doc(userRoot(), "decks", deckId);

async function commitInChunks(operations) {
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = writeBatch(db);
    operations.slice(offset, offset + 400).forEach(operation => operation(batch));
    await batch.commit();
  }
}

async function saveDeck(deck, delta = null) {
  if (!user) return;
  const root = deckRoot(deck.id);
  await setDoc(root, {
    id: deck.id, name: deck.name, settings: deck.settings, ownerId: user.uid,
    createdAt: deck.createdAt, updatedAt: deck.updatedAt,
    hasLocalMedia: Boolean(Object.keys(deck.media || {}).length)
  }, { merge: true });

  const cards = delta?.card ? [delta.card] : deck.cards;
  const reviews = delta?.review ? [delta.review] : delta ? [] : deck.reviews;
  const operations = [
    ...cards.map(card => batch => batch.set(doc(root, "cards", String(card.id)), card)),
    ...reviews.map(review => batch => batch.set(doc(root, "reviews", review.id), review))
  ];
  await commitInChunks(operations);
}

async function loadDecks() {
  if (!user) return [];
  const deckResults = await getDocs(collection(userRoot(), "decks"));
  return Promise.all(deckResults.docs.map(async snapshot => {
    const metadata = snapshot.data();
    const [cardResults, reviewResults] = await Promise.all([
      getDocs(collection(snapshot.ref, "cards")),
      getDocs(collection(snapshot.ref, "reviews"))
    ]);
    return {
      ...metadata,
      cards: cardResults.docs.map(item => item.data()),
      reviews: reviewResults.docs.map(item => item.data()).sort((a,b) => a.date.localeCompare(b.date)),
      media: {}, ownerId: user.uid, syncState: "synced"
    };
  }));
}

async function deleteDeck(deckId) {
  if (!user) return;
  const root = deckRoot(deckId);
  const [cards, reviews] = await Promise.all([getDocs(collection(root, "cards")), getDocs(collection(root, "reviews"))]);
  await commitInChunks([...cards.docs, ...reviews.docs].map(snapshot => batch => batch.delete(snapshot.ref)));
  await deleteDoc(root);
}

const api = {
  get user() { return user; },
  createAccount: (email, password) => createUserWithEmailAndPassword(auth, email, password),
  signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
  signOut: () => signOut(auth),
  saveDeck, loadDecks, deleteDeck
};

window.flipfeedCloud = api;
onAuthStateChanged(auth, nextUser => {
  user = nextUser;
  window.dispatchEvent(new CustomEvent("flipfeed-auth", { detail: nextUser ? { uid: nextUser.uid, email: nextUser.email } : null }));
});
window.dispatchEvent(new Event("flipfeed-firebase-ready"));
